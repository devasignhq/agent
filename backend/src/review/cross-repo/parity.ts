// Parity feature store + the sibling-maintainer heads-up.
//
// Three anti-spam guards, in order of how much work they do: `notifiedRepos` on
// the row (durable, so a re-review of the same PR is silent even after a
// restart), notify only on a transition, and one notification per feature rather
// than one per sibling — `installMembers` resolves to the same people either way.
import { v4 as uuid } from "uuid";
import { db } from "../../db.js";
import { installMembers } from "../../github/installations.js";
import { pushNotification } from "../../notifications.js";
import { symbolVariants } from "./naming.js";
import type { Installation, ParityFeature, PRReview, Repository } from "../../types.js";

export const MAX_PARITY_NOTIFICATIONS_PER_REVIEW = 3;

export type ParityFeatureInput = {
  slug: string;
  title: string;
  missingIn: string[];
  searched: string;
};

export function parityFeatureFor(installationId: string, featureId: string): ParityFeature | null {
  return db.find(
    "parityFeatures",
    (f) => f.installationId === installationId && f.featureId === featureId
  );
}

export function openParityGaps(installationId: string, repoFullName: string): ParityFeature[] {
  return db.filter(
    "parityFeatures",
    (f) =>
      f.installationId === installationId &&
      !f.closedAt &&
      f.statusByRepo[repoFullName] === "absent"
  );
}

export function recordParityFeatures(args: {
  install: Installation;
  repo: Repository;
  review: PRReview;
  features: ParityFeatureInput[];
  family?: string;
}): { opened: number; notified: number } {
  const repoFullName = `${args.repo.owner}/${args.repo.name}`;
  const now = Date.now();
  let opened = 0;
  let notified = 0;

  for (const f of args.features.slice(0, MAX_PARITY_NOTIFICATIONS_PER_REVIEW)) {
    const family = args.family || "cross-repo";
    const featureId = `${family}/${f.slug}`;
    const prior = parityFeatureFor(args.install.id, featureId);

    if (prior) {
      const statusByRepo = { ...prior.statusByRepo };
      for (const repo of f.missingIn) if (!statusByRepo[repo]) statusByRepo[repo] = "absent";
      db.update("parityFeatures", (x) => x.id === prior.id, {
        statusByRepo,
        lastSeenReviewId: args.review.id,
      });
      // No notification: the row already existed, so this is a re-review or a
      // second PR touching the same feature, not a new gap.
      continue;
    }

    const row: ParityFeature = {
      id: uuid(),
      installationId: args.install.id,
      family,
      featureId,
      title: f.title,
      summary: f.searched,
      origin: {
        repoId: args.repo.id,
        repoFullName,
        sha: args.review.headSha,
        prNumber: args.review.prNumber ?? null,
        at: now,
      },
      statusByRepo: Object.fromEntries(f.missingIn.map((r) => [r, "absent" as const])),
      evidence: Object.fromEntries(f.missingIn.map((r) => [r, f.searched])),
      openedAt: now,
      closedAt: null,
      closedBy: null,
      notifiedRepos: [],
      lastSeenReviewId: args.review.id,
    };
    db.insert("parityFeatures", row);
    opened += 1;

    const recipients = new Set(installMembers(args.install));
    if (recipients.size) {
      for (const userId of recipients) {
        pushNotification(
          userId,
          "review",
          `Feature parity gap: ${f.title}`,
          `${repoFullName} added this; missing in ${f.missingIn.join(", ")}.`,
          { link: `/reviews/${args.review.id}`, reviewId: args.review.id }
        );
      }
      db.update("parityFeatures", (x) => x.id === row.id, { notifiedRepos: [...f.missingIn] });
      notified += 1;
    }
  }

  return { opened, notified };
}

// A later PR on a sibling that adds the missing capability closes the gap.
// Positive confirmation matters as much as the warning did.
export function closeParityGapsFor(args: {
  installationId: string;
  repoFullName: string;
  addedNames: string[];
  sha: string;
  prNumber: number | null;
}): ParityFeature[] {
  const closed: ParityFeature[] = [];
  const addedVariants = new Set(args.addedNames.flatMap((n) => symbolVariants(n)));
  if (!addedVariants.size) return closed;

  for (const gap of openParityGaps(args.installationId, args.repoFullName)) {
    const gapVariants = symbolVariants(gap.featureId.split("/").pop() || "");
    if (!gapVariants.some((v) => addedVariants.has(v))) continue;
    const statusByRepo = { ...gap.statusByRepo, [args.repoFullName]: "present" as const };
    const stillMissing = Object.values(statusByRepo).some((s) => s === "absent");
    const patch: Partial<ParityFeature> = { statusByRepo };
    if (!stillMissing) {
      patch.closedAt = Date.now();
      patch.closedBy = { repoFullName: args.repoFullName, sha: args.sha, prNumber: args.prNumber };
    }
    const updated = db.update("parityFeatures", (x) => x.id === gap.id, patch);
    if (updated) closed.push(updated);
  }
  return closed;
}
