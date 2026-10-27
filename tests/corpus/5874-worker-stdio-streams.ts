import { Worker, isMainThread } from "node:worker_threads";

// The stdout and stderr options: the worker's console and process.stdout/
// process.stderr writes reach worker.stdout and worker.stderr instead of
// the process output, as Readable streams that end after the worker's
// 'exit' event. worker.stdin is null without the stdin option.
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), { stdout: true, stderr: true });
  let out = "";
  let err = "";
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  worker.stdout.on("end", () => console.log("stdout end", JSON.stringify(out)));
  worker.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  worker.stderr.on("end", () => console.log("stderr end", JSON.stringify(err)));
  worker.on("exit", (code: number) => console.log("exit", code));
  console.log("stdin", worker.stdin);
} else {
  console.log("hello from the worker");
  process.stdout.write("raw write\n");
  process.stdout.write(Buffer.from("bytes\n"));
  console.error("an error line");
  process.stderr.write("err bytes\n");
}
