// The Worker stdin option: worker.stdin is a Writable whose chunks the
// worker reads from process.stdin, which ends when worker.stdin ends.
// Without the option worker.stdin is null and the worker's process.stdin
// ends without data.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { Writable } from "node:stream";
import * as readline from "node:readline";

function run(mode: string, stdin: boolean, feed: (sink: Writable) => void, next: () => void): void {
  const worker = new Worker(new URL(import.meta.url), { argv: [mode], stdin });
  const messages: string[] = [];
  worker.on("message", (m: string) => messages.push(m));
  worker.on("exit", (code: number) => {
    console.log(mode, "exit", code, JSON.stringify(messages));
    next();
  });
  if (worker.stdin === null) console.log(mode, "stdin", null);
  else feed(worker.stdin);
}

if (isMainThread) {
  run("plain", false, () => {}, () =>
    run("chunks", true, (sink) => {
      sink.write("first line\n");
      sink.write(Buffer.from("second "));
      sink.end("line\n", () => console.log("chunks end callback"));
    }, () =>
      run("lines", true, (sink) => {
        sink.write("alpha\nbeta");
        sink.end("\ngamma\n");
      }, () => console.log("done"))));
} else if (process.argv[2] === "lines") {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => parentPort!.postMessage(line.toUpperCase()));
  rl.on("close", () => parentPort!.postMessage("closed"));
} else {
  const chunks: string[] = [];
  process.stdin.on("data", (d: Uint8Array) => {
    chunks.push(Buffer.from(d).toString());
  });
  process.stdin.on("end", () => parentPort!.postMessage(`${chunks.length} ${JSON.stringify(chunks.join(""))}`));
}
