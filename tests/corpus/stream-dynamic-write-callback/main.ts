// Write completion callbacks from a JavaScript module run unbound with
// Node's arguments: null after a successful write, the _write error after a
// failed one, and the write-after-end error. Their return value is ignored.
import { Writable } from "node:stream";
import { makeReporter } from "./report.js";

const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    callback(chunk.toString() === "bad" ? new Error("rejected") : null);
  },
});
sink.on("error", (error) => lines.push(`error event ${error.message}`));
sink.write("good", makeReporter(lines, "good"));
sink.write("bad", "utf8", makeReporter(lines, "bad"));

const ended = new Writable({
  write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    callback();
  },
});
ended.on("error", () => lines.push("ended error event"));
ended.end();
ended.write("late", makeReporter(lines, "late"));

setTimeout(() => {
  for (const line of lines) console.log(line);
}, 5);
