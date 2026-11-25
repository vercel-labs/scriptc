// Node evaluates the command before it reads the options record, so a
// command that sets `env` on the record decides which environment the
// child sees. The lowering evaluates the command first and tests the
// record after it, selecting the environment entry point from the value
// the command left behind.
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

const options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8" };
function command(): string {
  options.env = { SCR_ORDER: "set-by-command" };
  return "/usr/bin/env";
}

const result = spawnSync(command(), [], options);
const seen = String(result.stdout)
  .split("\n")
  .filter((line) => line.startsWith("SCR_ORDER="));
console.log("child env:", seen.join(","));
