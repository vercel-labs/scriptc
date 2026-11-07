// @requires-libnode
// The stdio of a child process a Node island started, used natively as general streams: stdin as a
// Writable (write with a callback, end with a last chunk, an 'error' listener), stdout and stderr
// as Readables (pipe into a PassThrough, async iteration, 'close'), as a stdio transport does.
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function closed(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("close", (code) => resolve(code)));
}

async function main(): Promise<void> {
  // A line protocol over stdin and stdout.
  const echo: ChildProcess = lib.start("while read line; do echo \"got $line\"; done; echo eof >&2");
  const replies: string[] = [];
  let buffered = "";
  const input = echo.stdin!;
  input.on("error", (error) => console.log("stdin error", error.message));
  echo.stdout?.on("error", (error) => console.log("stdout error", error.message));
  echo.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    let at = buffered.indexOf("\n");
    while (at >= 0) {
      replies.push(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      at = buffered.indexOf("\n");
    }
    if (replies.length === 1) input.write("two\n", (error) => console.log("second write done", error == null));
    if (replies.length === 2) input.end("three\n");
  });
  const errors = new PassThrough();
  let stderrText = "";
  errors.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString();
  });
  echo.stderr?.pipe(errors);
  input.write("one\n");
  console.log("close", await closed(echo), JSON.stringify(replies), JSON.stringify(stderrText));

  // Async iteration over stdout.
  const lines: ChildProcess = lib.start("echo a; sleep 0.05; echo b");
  let text = "";
  for await (const chunk of lines.stdout!) text += String(chunk);
  console.log("iterated", JSON.stringify(text), "exitCode", lines.exitCode);

}
main();
