export type Logger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

export function createLogger(sink: (line: string) => void = () => {}): Logger {
  const emit = (level: string) => (message: string, meta?: Record<string, unknown>) =>
    sink(`${level} ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
  return { info: emit("info"), warn: emit("warn") };
}
