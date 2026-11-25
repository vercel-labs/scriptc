// A process stream has getColorDepth and hasColors only while its descriptor
// is a terminal. The corpus runs on pipes, where Node's
// process.stdout is no tty.WriteStream: an optional call answers undefined
// and never evaluates its arguments, and a plain call is a TypeError.
import type { WriteStream } from "node:tty";

let evaluated = 0;
function palette(): object {
  evaluated++;
  return { COLORTERM: "truecolor" };
}

function depthOf(sink: WriteStream): number {
  return sink.getColorDepth?.(palette()) ?? 1;
}

function describe(sink: WriteStream): string {
  const rich = sink.hasColors?.(256, palette()) ?? "no answer";
  const plain = sink.hasColors?.() === undefined;
  return `rich=${String(rich)} plain=${String(plain)}`;
}

function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, String(run()));
  } catch (error) {
    console.log(label, error instanceof TypeError, (error as Error).message);
  }
}

console.log("depth", depthOf(process.stdout), depthOf(process.stderr));
console.log(describe(process.stdout), "|", describe(process.stderr));
console.log("arguments evaluated", evaluated);
attempt("stdout", () => process.stdout.getColorDepth());
attempt("stderr", () => process.stderr.hasColors(16));
const held = process.stderr;
attempt("held", () => held.getColorDepth({ TERM: "xterm" }));
console.log("held optional", held.getColorDepth?.({ TERM: "xterm" }) ?? "none");
// The answers collect in an array whose element type admits undefined.
const collected = [held.getColorDepth?.(palette()), held.hasColors?.(16, palette())];
console.log("collected", collected.map(String).join(" "), collected.length, evaluated);
