import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function requiresFullCi(eventName, event) {
  if (eventName !== "pull_request") return true;
  const pr = event?.pull_request;
  const stackBase = pr?.stack?.base?.ref;
  const prBase = pr?.base?.ref;
  // Missing or incomplete stack metadata must retain full validation. The
  // lowest unmerged layer targets the stack base; its position need not be 1.
  return (
    typeof stackBase !== "string" ||
    stackBase.length === 0 ||
    typeof prBase !== "string" ||
    prBase.length === 0 ||
    stackBase === prBase
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const full = requiresFullCi(process.env.GITHUB_EVENT_NAME, event);
  appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
  console.log(full ? "Run full CI" : "Run code quality for an upper stack layer");
}
