// @requires-libnode
// A program keeps the stream's own write method to write its real output
// past a replacement it installs: bound with .bind(process.stdout), by plain
// reference called with .call and .apply, and bound afresh at the call. Each
// is called later, from a promise chain, with a completion callback, with and
// without an encoding, while a Node island is running and writing through
// the replacement. The write happens, the callback runs once and after the
// bytes, and the lines of both sides keep Node's order.
import { callSync } from "@scriptc/node";

type RawWrite = (chunk: string, callback?: (error?: Error | null) => void) => boolean;
type Write = typeof process.stdout.write;

interface Takeover {
  rawOut: RawWrite;
  rawErr: RawWrite;
  original: Write;
}

let takeover: Takeover | undefined;
let tail: Promise<void> = Promise.resolve();
const completions: string[] = [];

function rawOut(): RawWrite {
  if (takeover) return takeover.rawOut;
  return process.stdout.write.bind(process.stdout) as RawWrite;
}

async function writeChunk(label: string, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      rawOut()(text, (error) => {
        completions.push(`${label}:${error === null || error === undefined}`);
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function writeRaw(label: string, text: string): void {
  tail = tail.then(() => writeChunk(label, text));
}

function takeOver(): void {
  const out = process.stdout.write.bind(process.stdout) as RawWrite;
  const err = process.stderr.write.bind(process.stderr) as RawWrite;
  const original = process.stdout.write;
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    if (typeof encodingOrCallback === "function") return err(`[stray] ${String(chunk)}`, encodingOrCallback);
    return err(`[stray] ${String(chunk)}`, callback);
  }) as Write;
  takeover = { rawOut: out, rawErr: err, original };
}

function restore(): void {
  if (!takeover) return;
  process.stdout.write = takeover.original;
  takeover = undefined;
}

async function main(): Promise<void> {
  // Node is running before anything is replaced.
  callSync("./chatter.cjs", "say", "before");
  writeRaw("fresh bind", "raw: bound at the call\n");
  await tail;

  takeOver();
  callSync("./chatter.cjs", "say", "taken over");
  console.log("native stray line");
  writeRaw("kept bind", "raw: kept bound method\n");
  writeRaw("empty", "");
  await tail;
  callSync("./chatter.cjs", "say", "between raw writes");

  // The saved method with an encoding and a callback, and its callbacks
  // against a later write: they run after the calls return.
  const saved = takeover!.original.bind(process.stdout) as Write;
  await new Promise<void>((resolve) => {
    saved("raw: saved, utf8 and callback\n", "utf8", () => {
      completions.push("encoding");
      resolve();
    });
    saved("raw: saved, a later write\n");
    completions.push("calls returned");
  });

  // The method by plain reference, with its receiver given at the call.
  const original = takeover!.original;
  await new Promise<void>((resolve) => {
    original.call(process.stdout, "raw: original.call\n", "utf8", () => {
      completions.push("call");
      resolve();
    });
  });
  const applied = original.apply(process.stdout, ["raw: original.apply\n", "utf8"]);
  await writeChunk("after call", "raw: kept bound method again\n");

  restore();
  callSync("./chatter.cjs", "say", "restored");
  console.log("applied", applied);
  console.log(completions.join(" "));
}

void main();
