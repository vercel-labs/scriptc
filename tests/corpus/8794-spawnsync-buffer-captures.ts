// spawnSync WITHOUT an { encoding } option captures Buffers (Node's
// SpawnSyncReturns<Buffer>): the result fields carry the bytes, the brand
// is observable (Buffer.isBuffer), and the Buffer read methods (utf8/hex/
// base64 toString, indexing, length) answer exactly as under Node. Two
// reads of a capture are the same object and writes through one read are
// visible through the next, as Node's one-Buffer-per-capture result has.
// The `formatSpawnFailure` shape real code uses — result.stderr?.toString()
// .trim() — is the trimmed stderr. With { encoding: "utf8" } the same
// fields stay strings.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const ok = spawnSync("/bin/sh", ["-c", "printf 'alpha\\n'; printf 'beta\\n' 1>&2"]);
console.log("status", ok.status, "signal", String(ok.signal));
console.log("isBuffer", Buffer.isBuffer(ok.stdout), Buffer.isBuffer(ok.stderr));
console.log("stdout", JSON.stringify(ok.stdout.toString()));
console.log("stderr", JSON.stringify(ok.stderr.toString()));
console.log("len", ok.stdout.length, ok.stderr.length);
console.log("hex", ok.stdout.toString("hex"));
console.log("base64", ok.stderr.toString("base64"));
console.log("bytes", ok.stdout[0], ok.stdout[4], ok.stdout[5], ok.stdout[ok.stdout.length - 1]);

// The tools-manager shape: a failed command's captured stderr, trimmed.
const failed = spawnSync("/bin/sh", ["-c", "printf 'boom\\n' 1>&2; exit 7"]);
const message = failed.stderr?.toString().trim() ?? "";
console.log("failed", failed.status, JSON.stringify(message));
console.log("failed-empty", failed.stdout?.toString().trim() === "");

// Non-utf8 bytes survive the capture; the utf8 decode is Node's lossy one.
const binary = spawnSync("/bin/sh", ["-c", "printf '\\377\\376\\000z'"]);
console.log("bin-hex", binary.stdout.toString("hex"));
console.log("bin-utf8", JSON.stringify(binary.stdout.toString()));
console.log("bin-bytes", binary.stdout[0], binary.stdout[1], binary.stdout[2], binary.stdout[3]);

// The options FORM without an encoding is still Buffer.
const opts = spawnSync("sh", ["-c", "echo piped"], { timeout: 10_000 });
console.log("opts", Buffer.isBuffer(opts.stdout), JSON.stringify(opts.stdout.toString()));

// Node builds one Buffer per capture together with the result: two reads
// of the property are the same object, a write through one read is visible
// through the next, and two captures (or two calls) are different objects.
const identity = spawnSync("/bin/sh", ["-c", "printf 'abcd'"]);
const captured = identity.stdout;
console.log("identity", captured === identity.stdout, identity.stderr === identity.stderr);
console.log("distinct", identity.stdout === identity.stderr, identity.stdout === ok.stdout);
captured.fill(0x58); // "XXXX"
console.log("mutated", JSON.stringify(identity.stdout.toString()), identity.stdout[0]);
identity.stdout.fill(0x59, 3); // "XXXY"
console.log("mutated2", JSON.stringify(captured.toString()));

// An explicit encoding keeps the string representation.
const text = spawnSync("sh", ["-c", "printf 'plain\\n'"], { encoding: "utf8" });
console.log("text", typeof text.stdout, JSON.stringify(text.stdout));

// util.inspect of a capture prints the raw bytes (`<Buffer 61 62 63>`), not
// a decoded string.
const inspected = spawnSync("/bin/sh", ["-c", "printf 'abc\\000d'"]);
console.log("inspect", inspected.stdout);

// pi's formatSpawnFailure shape: the capture arrives as a typed PARAMETER
// (`SpawnSyncReturns<Buffer>`), not as the call's own result expression.
function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
  return `exit ${String(result.status)}: ${result.stderr?.toString().trim() ?? ""}`;
}
console.log("param", formatSpawnFailure(failed));
