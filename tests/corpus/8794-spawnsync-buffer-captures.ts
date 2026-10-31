// spawnSync WITHOUT an { encoding } option captures Buffers (Node's
// SpawnSyncReturns<Buffer>): the result fields carry the bytes, the brand
// is observable (Buffer.isBuffer), and the Buffer read methods (utf8/hex/
// base64 toString, indexing, length) answer exactly as under Node. The
// `formatSpawnFailure` shape real code uses — result.stderr?.toString()
// .trim() — is the trimmed stderr. With { encoding: "utf8" } the same
// fields stay strings.
import { spawnSync } from "node:child_process";

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

// An explicit encoding keeps the string representation.
const text = spawnSync("sh", ["-c", "printf 'plain\\n'"], { encoding: "utf8" });
console.log("text", typeof text.stdout, JSON.stringify(text.stdout));
