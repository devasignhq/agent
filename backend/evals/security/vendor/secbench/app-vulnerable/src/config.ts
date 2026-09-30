export type Config = {
  env: string;
  port: number;
  pageSize: number;
  reportTimeoutMs: number;
  uploadsDir: string;
  reportHosts: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    env: env.NODE_ENV ?? "development",
    port: Number(env.PORT ?? 4310),
    pageSize: Math.min(Number(env.PAGE_SIZE ?? 25), 100),
    reportTimeoutMs: Number(env.REPORT_TIMEOUT_MS ?? 5000),
    uploadsDir: env.UPLOADS_DIR ?? "./var/uploads",
    reportHosts: (env.REPORT_HOSTS ?? "reports.example.com").split(",").map((h) => h.trim()).filter(Boolean),
  };
}
