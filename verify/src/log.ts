// GitHub-Actions-aware logging: groups fold in the job log, warnings surface
// in the annotations panel, and everything still reads fine in a terminal.
import { appendFileSync } from "node:fs";

const onActions = () => process.env.GITHUB_ACTIONS === "true";

export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  try {
    appendFileSync(file, `${name}=${value.replace(/\r?\n/g, " ")}\n`);
  } catch {
    // best-effort
  }
}

export const log = {
  info(msg: string): void {
    console.log(`devasign: ${msg}`);
  },
  warn(msg: string): void {
    if (onActions()) console.log(`::warning::${msg}`);
    console.log(`devasign: WARNING - ${msg}`);
  },
  error(msg: string): void {
    if (onActions()) console.log(`::error::${msg}`);
    console.error(`devasign: ERROR - ${msg}`);
  },
  group(title: string): void {
    if (onActions()) console.log(`::group::devasign: ${title}`);
    else console.log(`devasign: --- ${title}`);
  },
  endGroup(): void {
    if (onActions()) console.log("::endgroup::");
  },
};
