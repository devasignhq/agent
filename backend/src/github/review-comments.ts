// Inline review comments — the threads DevAsign opens against specific lines of
// a PR's diff. Thin layer over the REST API, mirroring app.ts's conventions:
// best-effort, logs and swallows, never throws into the review pipeline.
//
// Why one POST per comment rather than one review carrying comments[]:
//   - a single bad anchor 422s the WHOLE batch, and we would lose every thread;
//   - the comments[] array does not accept subject_type: "file", so file-level
//     fallback would be impossible;
//   - submitting a review with event "COMMENT" requires a body, which renders as
//     an extra conversation block — the thing the summary card replaces.
import { gh, ghPaged, GitHubApiError } from "./app.js";

export type ReviewCommentAnchor =
  | { kind: "line"; path: string; line: number; side: "RIGHT" }
  | { kind: "file"; path: string };

export type ReviewCommentRow = {
  id: number;
  body: string;
  path: string;
  // null once a later push pushed the anchored line out of the diff — GitHub
  // renders the thread "outdated" and stops reporting a live line for it.
  line: number | null;
  originalLine: number | null;
  inReplyToId: number | null;
};

function anchorPayload(anchor: ReviewCommentAnchor): Record<string, unknown> {
  return anchor.kind === "line"
    ? { path: anchor.path, line: anchor.line, side: anchor.side }
    : { path: anchor.path, subject_type: "file" };
}

/**
 * Open a thread. Returns the new comment id, or null when GitHub refused it.
 * A 422 means the anchor is not part of the diff; the caller retries at file
 * level (or drops the item onto the summary card) rather than losing it.
 */
export async function createPRReviewComment(
  installationId: number,
  owner: string,
  name: string,
  prNumber: number,
  args: { body: string; commitId: string; anchor: ReviewCommentAnchor }
): Promise<{ id: number } | { error: "anchor" | "rate_limit" | "other" }> {
  try {
    const res = await gh<{ id?: number }>(
      installationId,
      `/repos/${owner}/${name}/pulls/${prNumber}/comments`,
      {
        method: "POST",
        body: JSON.stringify({
          body: args.body,
          commit_id: args.commitId,
          ...anchorPayload(args.anchor),
        }),
        headers: { "Content-Type": "application/json" },
      }
    );
    if (typeof res?.id === "number") return { id: res.id };
    return { error: "other" };
  } catch (err) {
    const status = err instanceof GitHubApiError ? err.status : 0;
    if (status !== 422) {
      console.warn(
        `[github] failed to create review comment on ${owner}/${name}#${prNumber}:`,
        err
      );
    }
    // 403 here is the secondary rate limit ("you have exceeded a secondary rate
    // limit"), not a permission problem — the caller stops writing for this run.
    return { error: status === 422 ? "anchor" : status === 403 ? "rate_limit" : "other" };
  }
}

/**
 * Edit a thread's body in place. GitHub accepts `body` only — a thread cannot be
 * re-anchored, which is why a moved finding gets a relocation line instead.
 * "gone" distinguishes a deleted comment (drop the state) from a transient error.
 */
export async function updatePRReviewComment(
  installationId: number,
  owner: string,
  name: string,
  commentId: number,
  body: string
): Promise<"ok" | "gone" | "error"> {
  try {
    await gh(installationId, `/repos/${owner}/${name}/pulls/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
      headers: { "Content-Type": "application/json" },
    });
    return "ok";
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return "gone";
    console.warn(`[github] failed to update review comment ${owner}/${name}#${commentId}:`, err);
    return "error";
  }
}

export async function deletePRReviewComment(
  installationId: number,
  owner: string,
  name: string,
  commentId: number
): Promise<boolean> {
  try {
    await gh(installationId, `/repos/${owner}/${name}/pulls/comments/${commentId}`, {
      method: "DELETE",
    });
    return true;
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return true;
    console.warn(`[github] failed to delete review comment ${owner}/${name}#${commentId}:`, err);
    return false;
  }
}

// Every review comment on the PR, ours and everyone else's. Two uses: rebuilding
// thread state when the stored rows are lost, and learning which of our threads
// GitHub has marked outdated (`line: null`) after a push. Returns null — not [] —
// when the listing failed, so a transient error can't be read as "no threads".
export async function listPRReviewComments(
  installationId: number,
  owner: string,
  name: string,
  prNumber: number,
  opts: { maxPages?: number } = {}
): Promise<ReviewCommentRow[] | null> {
  const rows: ReviewCommentRow[] = [];
  let url: string | null = `/repos/${owner}/${name}/pulls/${prNumber}/comments?per_page=100`;
  const maxPages = opts.maxPages ?? 10;
  try {
    for (let page = 0; url && page < maxPages; page++) {
      const { body, nextUrl } = await ghPaged<
        Array<{
          id?: number;
          body?: string;
          path?: string;
          line?: number | null;
          original_line?: number | null;
          in_reply_to_id?: number | null;
        }>
      >(installationId, url);
      for (const c of body || []) {
        if (typeof c?.id !== "number") continue;
        rows.push({
          id: c.id,
          body: typeof c.body === "string" ? c.body : "",
          path: typeof c.path === "string" ? c.path : "",
          line: typeof c.line === "number" ? c.line : null,
          originalLine: typeof c.original_line === "number" ? c.original_line : null,
          inReplyToId: typeof c.in_reply_to_id === "number" ? c.in_reply_to_id : null,
        });
      }
      url = nextUrl;
    }
    return rows;
  } catch (err) {
    console.warn(
      `[github] failed to list review comments on ${owner}/${name}#${prNumber}:`,
      err
    );
    return null;
  }
}

// One review comment's current body. Needed when marking a thread fixed: the
// item is gone from this run, so the detail to collapse exists only on GitHub.
// "gone" means the comment was deleted; null means the read failed.
export async function getPRReviewComment(
  installationId: number,
  owner: string,
  name: string,
  commentId: number
): Promise<string | null | "gone"> {
  try {
    const res = await gh<{ body?: string }>(
      installationId,
      `/repos/${owner}/${name}/pulls/comments/${commentId}`
    );
    return typeof res?.body === "string" ? res.body : null;
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return "gone";
    console.warn(`[github] failed to read review comment ${owner}/${name}#${commentId}:`, err);
    return null;
  }
}
