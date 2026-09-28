// The environment a generated test runs with. Its code is model-written from repository
// content, so it never gets the runner's own credentials, and gets a repo secret only by name.

// The job's OIDC and runtime tokens, its GitHub token, DevAsign's own token, and the files
// that set later steps' env, PATH, outputs and summary.
const RUNNER_ONLY = /^(?:ACTIONS_.*|GITHUB_TOKEN|GH_TOKEN|DEVASIGN_TOKEN|GITHUB_(?:ENV|OUTPUT|PATH|STATE|STEP_SUMMARY))$/;
// Wider than the log redactor's list; AUTH and PWD only as whole parts, sparing GIT_AUTHOR_NAME,
// XAUTHORITY and PWDEBUG. A name wrongly withheld costs one line under verify.env.
const SECRET_NAME = /SECRET|TOKEN|KEY|PASS|CRED|PRIVATE|COOKIE|SESSION|DSN|DATABASE_URL|(?:^|_)(?:AUTH|PWD)(?:_|$)/i;
const SHELL_VARS: ReadonlySet<string> = new Set(["PWD", "OLDPWD"]);
// user:pass@ in a URL's authority, nested schemes (jdbc:postgresql://) and host lists included.
const URL_USERINFO = /^(?:[a-z][a-z0-9+.-]*:)+\/\/[^/?#\s]*@/i;
// A secret-looking key in a query string or a key=value connection string (libpq, JDBC, ADO.NET).
const KEYED_SECRET = /(?:^|[?&;\s])[\w.-]*(?:PASS|PWD|SECRET|TOKEN|KEY|AUTH|CRED)[\w.-]*\s*=/i;

// One loopback host, or none (a socket or file path). Anything else fails closed, a bare
// `postgres` included: on a self-hosted runner a search domain can resolve it to a real server.
function staysLocal(value: string): boolean {
  if (!/^(?:file:|[a-z][a-z0-9+.-]*:\/\/)/i.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (/(?:^|&)host(?:addr)?=/i.test(url.search.slice(1))) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return !host || host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127(?:\.\d+){3}$/.test(host);
}

export function withoutRunnerCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && !RUNNER_ONLY.test(name)));
}

export function generatedTestEnv(env: NodeJS.ProcessEnv, allow: readonly string[] = []): { env: NodeJS.ProcessEnv; withheld: string[] } {
  const allowed = new Set(allow);
  const out: NodeJS.ProcessEnv = {};
  const withheld: string[] = [];
  for (const [name, value] of Object.entries(withoutRunnerCredentials(env)) as Array<[string, string]>) {
    const looksSecret = (SECRET_NAME.test(name) && !SHELL_VARS.has(name)) || URL_USERINFO.test(value) || KEYED_SECRET.test(value);
    if (looksSecret && !staysLocal(value) && !allowed.has(name)) withheld.push(name);
    else out[name] = value;
  }
  return { env: out, withheld: withheld.sort() };
}
