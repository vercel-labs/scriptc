// @normalize-pid
// spawn with a `shell` option that is a boolean computed at run time, and
// with a literal `shell: true`, beside a separate argument list. With the
// shell off the list is the argument vector; with it on Node runs
// `file + " " + args.join(" ")`, unescaped, and the first such call of the
// process reports DEP0190 on stderr.
import { spawn } from "node:child_process";

interface Outcome {
  code: number | null;
  text: string;
  argv: string[];
}

function launch(file: string, args: string[], viaShell: boolean): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { shell: viaShell, stdio: ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      resolve({ code, text: Buffer.concat(chunks).toString("utf8"), argv: child.spawnargs });
    });
  });
}

function report(label: string, outcome: Outcome): void {
  console.log(label, outcome.code, JSON.stringify(outcome.text), JSON.stringify(outcome.argv));
}

async function main(): Promise<void> {
  const tricky = ["left", "right;  echo $((6*7))"];
  // Off: every list entry is one argument, spaces and operators included.
  report("off", await launch("/bin/echo", tricky, tricky.length > 5));
  // On: the entries join onto the command, and the shell splits and expands the line.
  report("on", await launch("echo", tricky, tricky.length === 2));
  // A boolean read from the environment: unset here, so the shell stays off.
  const requested = process.env["SPAWN_SHELL_RUNTIME_BOOLEAN"] !== undefined;
  report("env", await launch("/bin/sh", ["-c", "printf '%s,' \"$0\" \"$@\"; exit 3", "zero", "one two"], requested));
  // With the shell off a file that does not exist is an 'error' event.
  await new Promise<void>((resolve) => {
    const child = spawn("/no/such/dir/tool", ["--version"], { stdio: "ignore", shell: requested });
    child.once("error", (error) => {
      console.log("absent", (error as NodeJS.ErrnoException).code);
      resolve();
    });
  });
  // A literal `shell: true` joins the same way; the warning is not repeated.
  await new Promise<void>((resolve) => {
    spawn("exit", ["5"], { shell: true, stdio: "ignore" }).on("exit", (code) => {
      console.log("literal", code);
      resolve();
    });
  });
  // An empty list is the command line alone.
  report("alone", await launch("echo solo; exit 2", [], !requested));
}
main();
