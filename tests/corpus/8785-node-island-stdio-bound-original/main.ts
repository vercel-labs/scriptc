// @requires-libnode
// A program keeps the stream's own write method to write its real output
// past a replacement it installs: bound with .bind(process.stdout), by plain
// reference called with .call, and bound afresh at the call. Each is called
// later, from a promise chain, with a completion callback, while a Node
// island is running and writing through the replacement. The write happens,
// the callback runs once, and the lines of both sides keep Node's order.
import { callSync } from "@scriptc/node";

type RawWrite = (chunk: string, callback?: (error?: Error | null) => void) => boolean;

interface Takeover {
  rawOut: RawWrite;
  rawErr: RawWrite;
  original: typeof process.stdout.write;
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
  }) as typeof process.stdout.write;
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

  // The method by plain reference, with its receiver given at the call.
  const original = takeover!.original as unknown as RawWrite;
  await new Promise<void>((resolve) => {
    original.call(process.stdout, "raw: original.call\n", () => {
      completions.push("call:true");
      resolve();
    });
  });
  const applied: boolean = original.apply(process.stdout, ["raw: original.apply\n"]);
  await writeChunk("after call", "raw: kept bound method again\n");

  restore();
  callSync("./chatter.cjs", "say", "restored");
  console.log("applied", applied);
  console.log(completions.join(" "));
}

void main();
