// @requires-libnode
// One process.stdout.write for native code and Node islands. Native code
// replaces the method the way an output guard does, and the replacement
// sees what island code writes — a module called through @scriptc/node and
// a package that runs in an island — in program order, with the arguments
// Node passes: console's error handler, byte chunks, an encoding, a
// callback. The island sees the replacement as its own stream's write.
import { callSync } from "@scriptc/node";
import { report } from "chatty-pkg";

type RawWrite = (chunk: string, callback?: (error?: Error | null) => void) => boolean;
type Write = typeof process.stdout.write;

const rawStdout = process.stdout.write.bind(process.stdout) as RawWrite;
const rawStderr = process.stderr.write.bind(process.stderr) as RawWrite;
const originalOut = process.stdout.write;
const originalErr = process.stderr.write;
const seen: string[] = [];

function text(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
}

function guard(tag: string, forward: RawWrite | null): Write {
  return ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "-";
    const kind = typeof chunk === "string" ? "string" : "bytes";
    seen.push(`${tag} ${kind}/${encoding}/${done === undefined ? "-" : "fn"}:${text(chunk).trimEnd()}`);
    if (forward === null) {
      if (done !== undefined) done(null);
      return true;
    }
    return forward(`[${tag}] ${text(chunk)}`, done);
  }) as Write;
}

// Before any replacement, island writes reach the descriptor.
callSync("./island.cjs", "write", "zero");

// stdout is redirected to stderr, as an output guard does for a JSON channel.
process.stdout.write = guard("out", rawStderr);
console.log("native log");
callSync("./island.cjs", "write", "one");
process.stdout.write("native write\n");
console.log("package accepted", report("two"));
console.log(callSync<string>("./island.cjs", "probe"));
console.log("native stream", String(process.stdout.isTTY), String(process.stdout.columns), process.stdout.fd);
rawStdout("raw stdout bypasses the replacement\n");

// stderr is captured without being forwarded.
process.stderr.write = guard("err", null);
callSync("./island.cjs", "warn", "three");
console.error("native error");
process.stderr.write = originalErr;

process.stdout.write = originalOut;
callSync("./island.cjs", "write", "four");
console.log("restored", process.stdout.write === originalOut, process.stderr.write === originalErr);
console.log(seen.join("\n"));
// The write callbacks island code passed ran on the next tick.
setTimeout(() => console.log(callSync<string>("./island.cjs", "callbacks")), 10);
