// @requires-libnode
// TypeScript that replaces a stream's write through an untyped alias: the
// stream reaches the helper as a value, so no assignment names
// process.stdout. The island's output still reaches the replacement.
import { callSync } from "@scriptc/node";

function capture(stream: any, lines: string[]): () => void {
  const original = stream.write;
  stream.write = (chunk: unknown): boolean => {
    lines.push(typeof chunk === "string" ? chunk.trimEnd() : "<bytes>");
    return true;
  };
  return () => {
    stream.write = original;
  };
}

const lines: string[] = [];
const release = capture(process.stdout, lines);
console.log("native line");
callSync("./voice.cjs", "speak", "captured");
release();
callSync("./voice.cjs", "speak", "released");
console.log(JSON.stringify(lines));
