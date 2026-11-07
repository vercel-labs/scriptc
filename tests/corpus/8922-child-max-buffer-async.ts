// maxBuffer in exec and execFile, callback and promisified. Node limits
// each stream on its own, in UTF-16 units of the decoded text: the chunk
// that crosses the limit is cut to what still fits, both streams are
// destroyed, the child is killed, and the error is a RangeError with code
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER and `cmd` (plus `stdout` and `stderr`
// when promisified). The default is 1024 * 1024.
import { exec, execFile, execSync } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function describe(error: Error | null): string {
  if (error === null) return "null";
  const e = error as Error & { code?: string | number; cmd?: string };
  return `${e.name} ${JSON.stringify(e.message)} code=${e.code} cmd=${JSON.stringify(e.cmd)}`;
}
function run(command: string, maxBuffer: number): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { maxBuffer }, (error, stdout, stderr) => {
      resolve(`${describe(error)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
    });
  });
}
function runFile(file: string, args: string[], maxBuffer: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer }, (error, stdout, stderr) => {
      resolve(`${describe(error)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
    });
  });
}
function reporter(
  label: string,
  done: () => void,
): (error: Error | null, stdout: string, stderr: string) => void {
  return (error, stdout) => {
    console.log(label, describe(error), JSON.stringify(stdout));
    done();
  };
}
function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const e = error as Error & { code?: string };
    return `${e.name} ${e.code} ${JSON.stringify(e.message)}`;
  }
  return "no error";
}

async function main(): Promise<void> {
  // Ten bytes against a limit of four: the first four survive.
  console.log("over:", await run("printf abcdefghij", 4));
  console.log("exact:", await run("printf abcd", 4));
  console.log("stderr:", await run("printf abcdefghij >&2", 4));
  // Each stream has its own count.
  console.log("both under:", await run("printf abc; printf abc >&2", 4));
  // The limit counts UTF-8 bytes of the text and cuts in UTF-16 units.
  console.log("unicode:", await run("printf 'héllo wörld'", 4));
  // With exec, zero is a limit like any other: any output passes it.
  console.log("zero:", await run("printf a", 0));
  console.log("zero, silent:", await run("true", 0));
  console.log("infinity:", await run("printf abcdefghij", Infinity));
  console.log("execFile:", await runFile("/bin/sh", ["-c", "printf abcdefghij"], 4));

  // The child is killed and its pipes are let go, so a grandchild that
  // keeps them open does not delay the callback.
  const started = Date.now();
  console.log("sleeper:", await runFile("/bin/sh", ["-c", "printf abcdefghij; sleep 20; echo late"], 4));
  console.log("sleeper returned at the limit:", Date.now() - started < 10000);

  // The child's own events report the kill.
  await new Promise<void>((resolve) => {
    const child = exec("printf abcdefghij; sleep 20", { maxBuffer: 4 }, (error) => {
      console.log("callback:", describe(error));
    });
    child.on("exit", (code, signal) => console.log("exit:", code, signal));
    child.on("close", (code, signal) => {
      console.log("close:", code, signal);
      resolve();
    });
  });

  // A callback built by an expression that runs its own capture: that
  // capture has its own limit (the default), not this call's.
  await new Promise<void>((resolve) => {
    exec("printf ab", { maxBuffer: 4 }, reporter(`nested ${execSync("printf abcdefghij").toString()}:`, resolve));
  });
  await new Promise<void>((resolve) => {
    execFile("/bin/sh", ["-c", "printf ab"], { maxBuffer: 4 }, reporter(`nested file ${execSync("printf klmnopqrst").toString()}:`, resolve));
  });

  // The default limit, at it and one past it.
  await new Promise<void>((resolve) => {
    exec("head -c 1048576 /dev/zero | tr '\\0' a", (error, stdout) => {
      console.log("default at:", describe(error), stdout.length);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    exec("head -c 1048577 /dev/zero | tr '\\0' a; sleep 20", (error, stdout) => {
      console.log("default over:", describe(error), stdout.length);
      resolve();
    });
  });

  // Promisified: the rejection carries the cut outputs too.
  for (const [name, attempt] of [
    ["exec", () => execAsync("printf abcdefghij", { maxBuffer: 4 })],
    ["execFile", () => execFileAsync("/bin/sh", ["-c", "printf abcdefghij >&2"], { maxBuffer: 4 })],
  ] as const) {
    try {
      await attempt();
      console.log(name, "resolved");
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string };
      console.log(`promisified ${name}:`, describe(e), JSON.stringify(e.stdout), JSON.stringify(e.stderr));
    }
  }
  const fine = await execAsync("printf abcd", { maxBuffer: 4 });
  console.log("promisified exact:", JSON.stringify(fine.stdout));

  // An invalid limit throws where the call is made, before anything runs,
  // for the promisified forms too.
  console.log("invalid exec:", thrown(() => exec("echo ran >&2", { maxBuffer: -1 }, () => console.log("not called"))));
  console.log(
    "invalid execFile:",
    thrown(() => execFile("/bin/echo", ["ran"], { maxBuffer: NaN }, () => console.log("not called"))),
  );
  console.log("invalid promisified:", thrown(() => void execFileAsync("/bin/echo", ["ran"], { maxBuffer: -1 })));
}
main();
