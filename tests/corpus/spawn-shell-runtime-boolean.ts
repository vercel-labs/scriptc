// @normalize-pid
// spawn with a shell option decided at run time (the portable idiom
// `shell: process.platform === "win32"`) and with a literal `shell: true`,
// beside separate arguments. With the shell off the list is the argument
// vector; with it on Node runs `file + " " + args.join(" ")`, unescaped,
// and the first such call of the process reports DEP0190 on stderr.
import { spawn } from "node:child_process";

function run(label: string, command: string, extra: string, shell: boolean): Promise<void> {
  const [file, ...args] = command.split(" ");
  return new Promise<void>((resolve) => {
    const child = spawn(file!, [...args, extra], { stdio: ["ignore", "pipe", "inherit"], shell });
    let out = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", (error) => {
      console.log(label, "error", error.message);
      resolve();
    });
    child.on("close", (code) => {
      console.log(label, code, JSON.stringify(out), JSON.stringify(child.spawnargs));
      resolve();
    });
  });
}

function editor(command: string, file: string): Promise<number | null> {
  const [name, ...args] = command.split(" ");
  return new Promise<number | null>((resolve) => {
    const child = spawn(name!, [...args, file], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}

async function main(): Promise<void> {
  // Off: each argument stays one argument, operators and spaces included.
  await run("off", "/bin/echo a", "b;  $((1+2))", false);
  // On: the list joins onto the command and the shell splits and expands it.
  await run("on", "echo a", "b;  echo $((1+2))", true);
  // Decided by the platform: off here, so the editor gets the file as one argument.
  console.log("platform", await editor("/bin/sh -c", "exit 4"));
  console.log("missing", await editor("/definitely/not/a/command --flag", "x"));
  // A literal `shell: true` joins the same way; the warning is reported once.
  await new Promise<void>((resolve) => {
    const child = spawn("exit", ["7"], { stdio: "ignore", shell: true });
    child.on("close", (code) => {
      console.log("literal", code, JSON.stringify(child.spawnargs));
      resolve();
    });
  });
  // An empty list at run time is the command alone, with no warning of its own.
  const none: string[] = [];
  await new Promise<void>((resolve) => {
    const child = spawn("exit 2", none, { stdio: "ignore", shell: none.length === 0 });
    child.on("close", (code) => {
      console.log("empty", code);
      resolve();
    });
  });
}
main();
