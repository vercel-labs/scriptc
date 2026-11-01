// spawnSync WITHOUT an `encoding` option hands back Buffer captures, not
// strings (pi's tools-manager formats a failed command from
// `result.stderr?.toString().trim()`). The capture is the same bytes as the
// utf8 read, as the branded u8 view Buffer.from builds.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const r = spawnSync("/bin/sh", ["-c", "printf 'out\\n'; printf 'err\\n' 1>&2"]);
console.log("isBuffer", Buffer.isBuffer(r.stdout), Buffer.isBuffer(r.stderr));
console.log("text", JSON.stringify(r.stdout.toString()), JSON.stringify(r.stderr.toString().trim()));
console.log("length", r.stdout.length, r.stderr.length);
console.log("hex", r.stdout.toString("hex"));
console.log("inspect", r.stdout);
console.log("first", r.stdout[0], r.stdout[1]);

// The failed-command path pi formats: a non-zero exit still captures both.
const failed = spawnSync("/bin/sh", ["-c", "printf 'boom\\n' 1>&2; exit 3"]);
console.log("status", failed.status, JSON.stringify(failed.stderr.toString().trim()));

// pi's formatter: the optional chain over a non-optional capture.
function format(result: SpawnSyncReturns<Buffer>): string {
  return `exit ${result.status}: ${result.stderr?.toString().trim()}`;
}
console.log(format(failed));
