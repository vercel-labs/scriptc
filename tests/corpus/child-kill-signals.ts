// The typed lane's kill(): an omitted or undefined signal is SIGTERM, an
// integer and a name are the signal, and a union value resolves at the call.
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

const run = (label: string, act: (child: ChildProcess) => boolean): Promise<void> =>
  new Promise((resolve) => {
    const child = spawn("sleep", ["2"]);
    child.on("spawn", () => {
      let answer: string;
      try {
        answer = `ret ${act(child)}`;
      } catch (error) {
        const failure = error as { code?: string; message: string };
        answer = `throw ${failure.code} ${JSON.stringify(failure.message)}`;
      }
      if (!child.killed) child.kill("SIGKILL");
      console.log(label, answer);
    });
    child.on("error", () => {});
    child.on("close", () => resolve());
  });

async function main(): Promise<void> {
  await run("omitted", (child) => child.kill());
  await run("number", (child) => child.kill(0));
  await run("name", (child) => child.kill("SIGTERM"));
  await run("undefined", (child) => child.kill(undefined));
  const chosen: string | number | undefined = "SIGTERM";
  await run("union", (child) => child.kill(chosen));
}

main();
