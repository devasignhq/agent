// Typed client for the /v1 runner API.
import type { TokenSource } from "./oidc.js";
import { CLI_VERSION, type ArtifactSignFile, type ArtifactSignResponse, type ResolveRequest, type ResolveResponse, type RunView, type RunnerResults } from "./types.js";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message?: string) {
    super(message ?? `API ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ApiClient {
  constructor(
    private baseUrl: string,
    private token: TokenSource,
    private fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown, attempts = 3): Promise<{ status: number; body: T }> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${await this.token()}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-DevAsign-CLI": CLI_VERSION,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text();
        let parsed: unknown = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { raw: text.slice(0, 300) };
        }
        if (res.status >= 500 && i < attempts - 1) {
          lastErr = new ApiError(res.status, parsed);
          await sleep(1_000 * (i + 1));
          continue;
        }
        if (!res.ok) throw new ApiError(res.status, parsed);
        return { status: res.status, body: parsed as T };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        lastErr = err;
        if (i < attempts - 1) await sleep(1_000 * (i + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  resolve(body: ResolveRequest): Promise<ResolveResponse> {
    return this.request<ResolveResponse>("POST", "/v1/runs/resolve", body).then((r) => r.body);
  }

  signArtifacts(runId: string, files: ArtifactSignFile[]): Promise<ArtifactSignResponse> {
    return this.request<ArtifactSignResponse>("POST", `/v1/runs/${runId}/artifacts`, { files }).then((r) => r.body);
  }

  results(runId: string, payload: RunnerResults): Promise<{ ok: true; runId: string; status: string }> {
    return this.request<{ ok: true; runId: string; status: string }>("POST", `/v1/runs/${runId}/results`, payload).then((r) => r.body);
  }

  getRun(runId: string): Promise<RunView> {
    return this.request<RunView>("GET", `/v1/runs/${runId}`).then((r) => r.body);
  }
}
