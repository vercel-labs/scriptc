// A `spawnSync` result that crossed into a dynamic slot converts back to its
// native `SpawnSyncReturns` layout by unwrapping the boxed native value: the
// status, signal, stdout and stderr fields are the ones the call produced
// (Node has no conversion at all, so the reads answer identically).
import * as childProcess from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

function asDyn(value: unknown): unknown {
  return value;
}

const raw = asDyn(childProcess.spawnSync("/bin/sh", ["-c", "printf 'out'; printf 'err' >&2; exit 3"]));
const result = raw as SpawnSyncReturns;
console.log(result.status, String(result.signal));
console.log(String(result.stdout));
console.log(String(result.stderr));
