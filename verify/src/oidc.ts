// The job's GitHub Actions OIDC id-token — the runner's only credential.
// Needs `permissions: id-token: write` on the job.
export type TokenSource = () => Promise<string>;

const REFRESH_AFTER_MS = 4 * 60_000;

export function actionsTokenSource(
  audience: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch
): TokenSource {
  let cached: { token: string; at: number } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < REFRESH_AFTER_MS) return cached.token;
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) {
      throw new Error(
        "no OIDC token available: add `permissions: id-token: write` to the job (or pass --token for a local run)"
      );
    }
    const res = await fetchImpl(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { Authorization: `bearer ${bearer}`, Accept: "application/json; api-version=2.0" },
    });
    if (!res.ok) throw new Error(`OIDC token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { value?: string };
    if (!body.value) throw new Error("OIDC token response had no value");
    cached = { token: body.value, at: Date.now() };
    return body.value;
  };
}

export function staticTokenSource(token: string): TokenSource {
  return async () => token;
}
