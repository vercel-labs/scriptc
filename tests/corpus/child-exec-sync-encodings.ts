// child_process: the sync exec capture's encoding option decodes stdout,
// stderr and a failure's outputs with any Buffer encoding name, on
// execSync and execFileSync alike. The default echo of a captured stderr
// prints Node's decoded text, an encoding chosen at run time through a
// BufferEncoding value decodes per call, and a string `input` is encoded
// with the same name before it reaches the child's stdin.
import { execFileSync, execSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

const emit = "printf 'A\\377\\376\\000B'";

const encodings = [
  "utf8",
  "utf-8",
  "latin1",
  "binary",
  "ascii",
  "hex",
  "base64",
  "base64url",
  "utf16le",
  "utf-16le",
  "ucs2",
  "ucs-2",
] as const;

for (const encoding of encodings) {
  const out = execSync(emit, { encoding });
  console.log("sync", encoding, JSON.stringify(out));
}

const fileOut = execFileSync("printf", ["%s", "A\\377"], { encoding: "latin1" });
console.log("file latin1:", JSON.stringify(fileOut));

// Every alias of one encoding answers the same text.
console.log(
  "aliases:",
  execSync(emit, { encoding: "binary" }) === execSync(emit, { encoding: "latin1" }),
  execSync(emit, { encoding: "ucs2" }) === execSync(emit, { encoding: "utf16le" }),
);

// A failure decodes the error's outputs with the same name, and the
// message appends the decoded stderr.
for (const encoding of ["latin1", "hex", "base64", "utf8"] as const) {
  try {
    execSync("printf 'o\\377'; printf 'e\\376' 1>&2; exit 5", { encoding, stdio: "pipe" });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; output?: (string | null)[] };
    console.log(
      "fail",
      encoding,
      err.status,
      JSON.stringify(err.stdout),
      JSON.stringify(err.stderr),
      JSON.stringify(err.output ?? []),
    );
    console.log("message", encoding, JSON.stringify((e as Error).message.split("\n")[1]));
  }
}

// Without a stdio option Node echoes the decoded stderr, so a latin1
// capture reaches our stderr as utf8 text (the harness compares bytes).
execSync("printf 'echo\\377' 1>&2", { encoding: "latin1" });

// A BufferEncoding-typed value is the string form, read at the call.
function capture(command: string, encoding: BufferEncoding): string {
  return execSync(command, { encoding });
}
console.log("runtime name:", JSON.stringify(capture("printf 'r\\377'", "latin1")));
console.log("runtime hex:", capture("printf 'rk'", "hex"));

// A string input is encoded with the options encoding, exactly Node's
// Buffer.from(input, encoding): latin1 writes one byte per code point and
// hex decodes the text. A typed options record carries any Buffer encoding
// name to stdin and to the capture.
console.log(
  "input latin1:",
  JSON.stringify(execSync("od -An -tx1", { input: "éA", encoding: "latin1" })),
);
console.log("input hex:", JSON.stringify(execSync("od -An -tx1", { input: "4142", encoding: "hex" })));
const latinFile: ExecFileSyncOptionsWithStringEncoding = { encoding: "latin1", input: "éA" };
console.log("typed latin1:", JSON.stringify(execFileSync("od", ["-An", "-tx1"], latinFile)));
const hexFile: ExecFileSyncOptionsWithStringEncoding = { encoding: "hex", input: "4142" };
console.log("typed hex:", JSON.stringify(execFileSync("od", ["-An", "-tx1"], hexFile)));
function captureInput(command: string, encoding: BufferEncoding): string {
  return execSync(command, { input: "éA", encoding });
}
console.log("runtime input:", JSON.stringify(captureInput("od -An -tx1", "binary")));

console.log("done");
