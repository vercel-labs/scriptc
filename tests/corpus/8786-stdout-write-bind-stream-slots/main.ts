// A program whose stream slots also hold JavaScript objects (a sink a
// JavaScript module makes goes where a NodeJS.WritableStream is expected),
// and which keeps process.stdout's own write method: bound, and by plain
// reference called with .call. The receiver of those calls is the stream
// itself, so each write happens and its callback runs once.
import { PassThrough } from "node:stream";
import { makeSink } from "./sink.js";

type RawWrite = (chunk: string, callback?: (error?: Error | null) => void) => boolean;

function report(out: NodeJS.WritableStream, text: string): void {
  out.write(text);
}

const lines: string[] = [];
report(makeSink(lines), "to a JavaScript sink\n");
const pass = new PassThrough();
pass.on("data", (chunk: Buffer | string) => lines.push(`pass ${chunk.toString().trimEnd()}`));
report(pass, "to a PassThrough\n");
report(process.stdout, "to stdout through a stream slot\n");

const bound = process.stdout.write.bind(process.stdout) as RawWrite;
const boundErr = process.stderr.write.bind(process.stderr) as RawWrite;
const original = process.stdout.write as unknown as RawWrite;
const done: string[] = [];

bound("bound write\n", (error) => {
  done.push(`bound:${error === null || error === undefined}`);
  boundErr("bound stderr write\n", () => {
    done.push("stderr");
    original.call(process.stdout, "call write\n", () => {
      done.push("call");
      const applied = original.apply(process.stdout, ["apply write\n"]);
      console.log(applied, done.join(" "), JSON.stringify(lines));
    });
  });
});
