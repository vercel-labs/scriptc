// write() on a process stream held as a value, with a completion callback,
// an encoding, or bytes: the call is made on the stream object. The callback
// runs from a tick after the write, with null, and still runs when nothing
// else keeps the program alive.
import type { WriteStream } from "node:tty";

const order: string[] = [];
function emit(panel: WriteStream, text: string, after?: () => void): void {
  panel.write(text, (problem) => {
    const what = problem === null ? "null" : problem === undefined ? "undefined" : "error";
    order.push("written:" + text.trim() + ":" + what);
    after?.();
  });
}
process.nextTick(() => order.push("tick-before"));
void Promise.resolve().then(() => order.push("microtask-before"));
setImmediate(() => order.push("immediate"));
emit(process.stdout, "first\n", () => emit(process.stdout, "nested\n"));
emit(process.stderr, "second\n");
order.push("sync-after");
process.nextTick(() => order.push("tick-after"));
void Promise.resolve().then(() => order.push("microtask-after"));

function encoded(panel: WriteStream): void {
  panel.write("plain é\n", "utf8");
  panel.write("68690a", "hex");
  panel.write("aGV5Cg==", "base64", (problem) => order.push("base64:" + (problem === null)));
  panel.write("latin é\n", "latin1", () => order.push("latin1"));
}
encoded(process.stdout);

function bytes(panel: WriteStream): void {
  panel.write(new Uint8Array([111, 110, 101, 10]));
  panel.write(Buffer.from("two\n"), (problem) => order.push("bytes:" + (problem === null)));
  const mixed: string | Uint8Array = order.length > 0 ? Buffer.from("three\n") : "never\n";
  panel.write(mixed, () => order.push("mixed"));
}
bytes(process.stdout);

// The boolean the write answers.
function accepted(panel: WriteStream): boolean {
  const first = panel.write("row\n", () => order.push("row"));
  console.log("accepted", first, typeof first);
  if (panel.write("again\n", "utf8", () => {})) console.log("still accepting");
  return first;
}
console.log(accepted(process.stdout));

// Through an optional chain.
function maybe(panel: WriteStream | undefined, label: string): void {
  const result = panel?.write(label + "\n", () => order.push(label));
  console.log(label, result);
}
maybe(process.stdout, "present");
maybe(undefined, "absent");

// An encoding name is read as Node reads it: in any ASCII case, an empty name
// is the default, and a name that is no encoding throws before anything is
// written, for a byte chunk too.
function encodings(panel: WriteStream): void {
  panel.write("7a0a", "HEX" as BufferEncoding);
  panel.write("upper\n", "UTF-8" as BufferEncoding);
  panel.write("empty\n", "" as BufferEncoding);
  try {
    panel.write("never\n", "bogus" as BufferEncoding);
  } catch (problem) {
    const failure = problem as Error & { code?: string };
    console.log("bogus:", failure.name, failure.message, failure.code);
  }
  try {
    panel.write(Buffer.from("never\n"), "nope" as BufferEncoding, () => {});
  } catch (problem) {
    console.log("bytes:", (problem as Error).message);
  }
}
encodings(process.stdout);

// A stream held in an untyped binding takes the same path.
const loose: any = process.stdout;
loose.write("loose\n", (problem: unknown) => order.push("loose:" + (problem === null)));

setTimeout(() => console.log(order.join(" ")), 10);
