// Replacing process.stdout.write from TypeScript: the output-guard idiom.
// The real write methods are taken first with bind (they write straight
// to the descriptor, past any later patch). The replacement then sees
// every stdout write: console.log's lines, direct string and byte writes
// with their encoding and callback arguments as passed. Assigning the
// saved method back restores the stream.
type RawWrite = (chunk: string, callback?: (error?: Error | null) => void) => boolean;

const rawStdout = process.stdout.write.bind(process.stdout) as RawWrite;
const rawStderr = process.stderr.write.bind(process.stderr) as RawWrite;
const original = process.stdout.write;
const captured: string[] = [];

function text(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
}

process.stdout.write = ((
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
): boolean => {
  const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
  const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "-";
  captured.push(`${typeof chunk === "string" ? "string" : "bytes"}/${encoding}:${text(chunk).trimEnd()}`);
  return rawStderr(`[redirected] ${text(chunk)}`, done);
}) as typeof process.stdout.write;

console.log("from console.log", 42);
process.stdout.write("direct string\n");
process.stdout.write(new Uint8Array([104, 105, 10]));
process.stdout.write("6869210a", "hex");
process.stdout.write("with callback\n", (error) => {
  rawStderr(`callback error is null: ${error === null}\n`);
});
const accepted = process.stdout.write("result\n");
rawStdout("raw stdout bypasses the patch\n");
console.log("same method", process.stdout.write === original, accepted);

process.stdout.write = original;
console.log("restored", process.stdout.write === original);
console.log(captured.join(" | "));
