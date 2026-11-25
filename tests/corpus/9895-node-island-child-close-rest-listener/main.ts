// @requires-libnode
// A listener of a child process a Node island started that takes its arguments as a rest
// parameter is an untyped listener. On 'close' it runs in the emit that ends the child, in the
// order it was registered, with the code and the signal, like the typed listeners around it.
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function watch(name: string, script: string): Promise<void> {
  return new Promise((resolve) => {
    const child: ChildProcess = lib.start(script);
    const log: string[] = [];
    child.on("exit", (...args) => {
      log.push(`exit rest ${JSON.stringify(args)}`);
    });
    child.on("close", (code) => {
      log.push(`close typed ${code}`);
    });
    child.on("close", (...args) => {
      log.push(`close rest ${JSON.stringify(args)}`);
    });
    child.on("close", (...args) => {
      log.push(`close rest again ${args.length}`);
    });
    child.on("close", () => {
      console.log(`${name}: ${log.join(" | ")}`);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  await watch("code", "exit 3");
  await watch("signal", "kill -TERM $$");
  await watch("output first", "echo hello");
}
main();
