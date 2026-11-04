// spawn's `shell: true`: the command string runs through /bin/sh -c, and
// the child is an ordinary spawn child — piped streams and the
// exit/close events behave as without the shell. The complete command goes
// in the first argument with an empty args list (Node's DEP0190 warning
// covers separate shell arguments, which the compiler refuses).
import { spawn } from "node:child_process";

function run(command: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn(command, [], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      console.log(
        `run: ${JSON.stringify(stdout.trim())} ${JSON.stringify(stderr.trim())} ${code} ${signal}`,
      );
      resolve();
    });
  });
}

await run("echo from spawn");
await run("printf '%s|%s' a b");
// The shell's own syntax applies to the line.
await run("printf 'x-y'");
// A non-zero shell exit reaches the close event's code.
await run("exit 7");
// stderr is the shell's, not a spawn error.
await run("echo oops >&2; exit 0");
// The shell's own quoting survives the trip.
await run("printf '%s' \"$(printf 'a b')\"");
