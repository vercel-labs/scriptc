// child_process: the sync exec capture's Buffer result. Without an
// encoding option — or with "buffer"/null, which Node normalizes the same
// way — execSync and execFileSync answer a Buffer, and a failure's
// stdout/stderr/output carry Buffers too. Bytes above ASCII pin that the
// capture is not a decoded string.
import { execFileSync, execSync } from "node:child_process";

const raw = execSync("printf 'A\\377B'");
console.log("default:", Buffer.isBuffer(raw), raw.length, raw.toString("hex"), raw[0], raw[2]);
console.log("latin1 view:", JSON.stringify(raw.toString("latin1")));
console.log("slice:", raw.subarray(1, 2).toString("hex"), raw.equals(Buffer.from([0x41, 0xff, 0x42])));

const named = execSync("printf 'hi'", { encoding: "buffer" });
console.log("buffer option:", Buffer.isBuffer(named), JSON.stringify(named.toString()));

const nil = execSync("printf 'yo'", { encoding: null });
console.log("null option:", Buffer.isBuffer(nil), JSON.stringify(nil.toString()));

const file = execFileSync("printf", ["x\\001"], { cwd: "/" });
console.log("execFileSync:", Buffer.isBuffer(file), file.toString("hex"));

// Newlines and empty output are ordinary bytes.
const lines = execSync("printf 'one\\ntwo\\n'");
console.log("lines:", lines.toString("utf8").split("\n").length, JSON.stringify(lines.toString()));
const empty = execSync("true");
console.log("empty:", Buffer.isBuffer(empty), empty.length);

// A non-zero exit: Node's message decodes stderr as utf8 (the Buffer's
// stringification), while the properties stay Buffers.
try {
  execSync("printf 'out\\377'; printf 'bad\\376' 1>&2; exit 3", { stdio: "pipe" });
} catch (e) {
  const err = e as {
    status?: number;
    signal?: string | null;
    stdout?: Buffer;
    stderr?: Buffer;
    output?: (Buffer | null)[];
  };
  console.log("fail:", err.status, err.signal, Buffer.isBuffer(err.stdout), Buffer.isBuffer(err.stderr));
  console.log("fail bytes:", err.stdout?.toString("hex"), err.stderr?.toString("hex"));
  console.log(
    "fail output:",
    (err.output ?? []).map((o) => (o === null ? "null" : o.toString("hex"))).join(","),
  );
  console.log("fail message:", JSON.stringify((e as Error).message));
}

// The default echo of a failed capture forwards the child's stderr bytes
// (a valid utf8 sequence here, so the sanitized lane's stderr normalization
// keeps them).
try {
  execSync("printf 'shown\\303\\277' 1>&2; exit 2");
} catch (e) {
  console.log("echo failure:", (e as Error).message.split("\n")[0]);
}

console.log("done");
