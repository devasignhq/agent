// Spawn with argv arrays only (never a shell string), capture output, kill on timeout.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ExecResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: string;
  stdout: string;
  stderr: string;
  output: string; // interleaved, what the log artifact holds
  durationMs: number;
};

const MAX_CAPTURE = 5 * 1024 * 1024;
const DRAIN_MS = 2_000;

export async function runCommand(opts: {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  logFile?: string;
  onLine?: (line: string) => void;
}): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let output = "";
    let timedOut = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    // "close" waits for every holder of the pipes, so a grandchild that outlives
    // its parent keeps it from ever firing. Settle once the child has exited and
    // the output has been quiet for DRAIN_MS instead.
    const armDrain = () => {
      if (!exited) return;
      clearTimeout(drain);
      drain = setTimeout(() => finish({ ...exited!, timedOut }), DRAIN_MS);
    };
    // Node's test runner marks its own children via NODE_TEST_CONTEXT; a test
    // process spawned from inside one (our integration suite) must not inherit it.
    const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env || {}), CI: "true", FORCE_COLOR: "0" };
    for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_")) delete env[k];
    // Own process group: a test runner reached through a wrapper (npx, npm exec)
    // spawns grandchildren, and killing only the direct child leaves them running.
    const group = process.platform !== "win32";
    const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: group });
    const killAll = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killAll();
    }, opts.timeoutMs);
    const take = (chunk: Buffer, which: "out" | "err") => {
      const s = chunk.toString("utf8");
      if (which === "out") stdout = (stdout + s).slice(-MAX_CAPTURE);
      else stderr = (stderr + s).slice(-MAX_CAPTURE);
      output = (output + s).slice(-MAX_CAPTURE);
      if (opts.onLine) for (const line of s.split("\n")) if (line) opts.onLine(line);
      armDrain();
    };
    child.stdout?.on("data", (c) => take(c, "out"));
    child.stderr?.on("data", (c) => take(c, "err"));
    const finish = (result: Omit<ExecResult, "stdout" | "stderr" | "output" | "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      const full: ExecResult = { ...result, stdout, stderr, output, durationMs: Date.now() - started };
      if (opts.logFile) {
        try {
          mkdirSync(path.dirname(opts.logFile), { recursive: true });
          writeFileSync(opts.logFile, `$ ${opts.cmd} ${opts.args.join(" ")}\n\n${output}\n\n[exit ${full.code ?? full.signal}${timedOut ? " — timed out" : ""}${full.spawnError ? ` — ${full.spawnError}` : ""}]\n`);
        } catch {
          // best-effort
        }
      }
      resolve(full);
    };
    child.on("error", (err) => finish({ code: null, signal: null, timedOut, spawnError: err.message }));
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      armDrain();
    });
    child.on("close", (code, signal) => finish({ code, signal, timedOut }));
  });
}
