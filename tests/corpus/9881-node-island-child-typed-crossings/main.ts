// @requires-libnode
// The ways an island's child process reaches a native ChildProcess slot where the compiler sees the
// crossing: the declared result of a package function handed to a typed parameter, kept in a field,
// the payload of a promise, and the argument of a callback the island calls.
import type { ChildProcess } from "node:child_process";
import { each, later, start } from "spawn-pkg";

function finished(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", (error) => resolve(`error:${error.message}`));
    child.on("close", (code, signal) => resolve(`${out.trim()} close:${code} ${signal}`));
  });
}

class Transport {
  private process: ChildProcess | undefined;
  open(script: string): Promise<string> {
    this.process = start("sh", ["-c", script]);
    return finished(this.process);
  }
  close(): boolean {
    const sent = this.process?.kill() ?? false;
    this.process = undefined;
    return sent;
  }
}

async function main(): Promise<void> {
  // A typed parameter.
  const child: ChildProcess = start("sh", ["-c", "echo parameter"]);
  console.log("parameter ->", await finished(child));

  // A field, closed from another method.
  const transport = new Transport();
  const done = transport.open("cat");
  setTimeout(() => console.log("kill sent", transport.close()), 50);
  console.log("field ->", await done);

  // A promise's payload.
  const awaited: ChildProcess = await later("sh", ["-c", "echo payload"]);
  console.log("payload ->", await finished(awaited));

  // A callback's argument.
  const results: Promise<string>[] = [];
  each(["echo first", "echo second; exit 2"], (made: ChildProcess, script: string) => {
    results.push(finished(made).then((line) => `${script} -> ${line}`));
  });
  for (const line of await Promise.all(results)) console.log("callback:", line);
}
main();
