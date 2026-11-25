// A program whose stream slots also hold JavaScript objects (a sink a
// JavaScript module makes goes where a NodeJS.WritableStream is expected),
// and which keeps process.stdout's own write method past a replacement it
// installs: bound, and by plain reference called with .call and .apply. The
// receiver of those calls is the stream itself, so each write happens, with
// (string, callback) and with (string, encoding, callback), and each
// callback runs once, after the bytes and in Node's order against later
// writes.
import { PassThrough } from "node:stream";
import { makeSink } from "./sink.js";

type Write = typeof process.stdout.write;

function report(out: NodeJS.WritableStream, text: string): void {
  out.write(text);
}

const lines: string[] = [];
report(makeSink(lines), "to a JavaScript sink\n");
const pass = new PassThrough();
pass.on("data", (chunk: Buffer | string) => lines.push(`pass ${chunk.toString().trimEnd()}`));
report(pass, "to a PassThrough\n");
report(process.stdout, "to stdout through a stream slot\n");

const rawOut = process.stdout.write.bind(process.stdout) as Write;
const rawErr = process.stderr.write.bind(process.stderr) as Write;
const original = process.stdout.write;
const order: string[] = [];

// Stray stdout goes to stderr; the program's own output uses the saved write.
process.stdout.write = ((chunk: string | Uint8Array): boolean =>
  rawErr(`[stray] ${String(chunk)}`)) as Write;

console.log("a stray console line");
rawOut("saved write, callback\n", (error) => {
  order.push(`callback:${error === null || error === undefined}`);
});
rawOut("saved write, encoding and callback\n", "utf8", () => {
  order.push("encoding callback");
});
rawOut("6865782077726974650a", "hex", () => {
  order.push("hex callback");
});
order.push("after the calls");
rawOut("a later write\n");
process.stdout.write("a stray direct write\n");

setTimeout(() => {
  // By plain reference, with the receiver given at the call.
  original.call(process.stdout, "original.call\n", "utf8", () => {
    order.push("call callback");
    const applied = original.apply(process.stdout, ["original.apply\n", "utf8"]);
    process.stdout.write = original;
    console.log(applied, order.join(" | "), JSON.stringify(lines));
  });
}, 5);
