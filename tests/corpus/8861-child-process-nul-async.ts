// The asynchronous launches refuse a NUL the way the synchronous ones do:
// spawn, execFile, exec and their promisified forms throw
// ERR_INVALID_ARG_VALUE from the call itself, before a process exists, so
// no 'error' event fires, no callback runs and no promise is returned.
// Every launch here would create a marker file; a refused launch leaves none.
import { exec, execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const dir = mkdtempSync(join(tmpdir(), "scriptc-nul-"));
const env = { PATH: process.env["PATH"] ?? "" };
const labels: string[] = [];
const running: Promise<void>[] = [];
// What each launch's callback or promise reported, printed in launch order.
const reported = new Map<string, string>();
// The callback a launch was given settles this, once the launch returned.
let awaited: Promise<void> | null = null;

function check(label: string, launch: (touch: string) => ChildProcess | Promise<unknown> | void): void {
  const name = "marker" + labels.length;
  labels.push(label);
  awaited = null;
  try {
    const started = launch("touch " + name);
    console.log(label, "returned");
    if (awaited !== null) running.push(awaited);
    if (started instanceof Promise) {
      running.push(
        started.then(
          () => void reported.set(label, "fulfilled"),
          (e: Error) => void reported.set(label, "rejected " + e.message),
        ),
      );
    }
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, "threw", e.name, e.code, JSON.stringify(e.message.split(dir).join("<dir>")));
  }
}

function closed(child: ChildProcess): ChildProcess {
  running.push(new Promise<void>((resolve) => child.on("close", () => resolve())));
  child.on("error", (e) => console.log("error event", e.message));
  return child;
}

function done(label: string): (error: Error | null) => void {
  let finish: () => void = () => {};
  awaited = new Promise<void>((resolve) => { finish = resolve; });
  return (error) => {
    reported.set(label, "callback " + (error === null ? "without an error" : error.message));
    finish();
  };
}

function pick(label: string): (error: Error | null) => void {
  console.log("  evaluated the callback of", label);
  return (error) => void reported.set(label, "callback " + (error === null ? "without an error" : error.message));
}

// spawn
check("spawn argument", (touch) => closed(spawn("sh", ["-c", touch, "a\u0000b"], { cwd: dir })));
check("spawn file", (touch) => closed(spawn("sh\u0000x", ["-c", touch], { cwd: dir })));
check("spawn file, no options", () => closed(spawn("sh\u0000x", ["-c", "exit 0"])));
check("spawn empty file", (touch) => closed(spawn("", ["-c", touch], { cwd: dir })));
check("spawn env value", (touch) => closed(spawn("sh", ["-c", touch], { cwd: dir, env: { ...env, A: "x\u0000y" } })));
check("spawn env key", (touch) => closed(spawn("sh", ["-c", touch], { cwd: dir, env: { ...env, ["A\u0000B"]: "1" } })));
check("spawn cwd", (touch) => closed(spawn("sh", ["-c", touch], { cwd: dir + "\u0000/x" })));
check("spawn shell command", (touch) => closed(spawn(touch + " \u0000 x", [], { cwd: dir, shell: true })));
check("spawn", (touch) => closed(spawn("sh", ["-c", touch], { cwd: dir })));

// spawn with an options value
const options: SpawnOptions = { cwd: dir };
const badCwd: SpawnOptions = { cwd: dir + "\u0000/x" };
const badEnv: SpawnOptions = { cwd: dir, env: { ...env, A: "x\u0000y" } };
const badKey: SpawnOptions = { cwd: dir, env: { ...env, ["A\u0000B"]: "1" } };
check("spawn options value, argument", (touch) => closed(spawn("sh", ["-c", touch, "a\u0000b"], options)));
check("spawn options value, file", (touch) => closed(spawn("sh\u0000x", ["-c", touch], options)));
check("spawn options value, cwd", (touch) => closed(spawn("sh", ["-c", touch], badCwd)));
check("spawn options value, env value", (touch) => closed(spawn("sh", ["-c", touch], badEnv)));
check("spawn options value, env key", (touch) => closed(spawn("sh", ["-c", touch], badKey)));
check("spawn options value", (touch) => closed(spawn("sh", ["-c", touch], options)));

// execFile
check("execFile argument", (touch) => execFile("sh", ["-c", touch, "a\u0000b"], { cwd: dir }, done("execFile argument")));
check("execFile file", (touch) => execFile("sh\u0000x", ["-c", touch], { cwd: dir }, done("execFile file")));
check("execFile file, no options", () => execFile("sh\u0000x", ["-c", "exit 0"], done("execFile file, no options")));
check("execFile cwd", (touch) => execFile("sh", ["-c", touch], { cwd: dir + "\u0000/x" }, done("execFile cwd")));
check("execFile shell file", (touch) => execFile(touch + " \u0000 x", [], { cwd: dir, shell: true }, done("execFile shell file")));
check("execFile callback expression", () => execFile("sh\u0000x", [], pick("execFile callback expression")));
check("execFile", (touch) => execFile("sh", ["-c", touch], { cwd: dir }, done("execFile")));

// exec
check("exec command", (touch) => exec(touch + " \u0000 x", { cwd: dir }, done("exec command")));
check("exec empty command", () => exec("", { cwd: dir }, done("exec empty command")));
check("exec cwd", (touch) => exec(touch, { cwd: dir + "\u0000/x" }, done("exec cwd")));
check("exec", (touch) => exec(touch, { cwd: dir }, done("exec")));

// the promisified forms
check("promisified execFile argument", (touch) => execFileAsync("sh", ["-c", touch, "a\u0000b"], { cwd: dir }));
check("promisified execFile file", (touch) => execFileAsync("sh\u0000x", ["-c", touch], { cwd: dir }));
check("promisified execFile env value", (touch) =>
  execFileAsync("sh", ["-c", touch], { cwd: dir, env: { ...env, A: "x\u0000y" } }));
check("promisified execFile cwd", (touch) => execFileAsync("sh", ["-c", touch], { cwd: dir + "\u0000/x" }));
check("promisified execFile", (touch) => execFileAsync("sh", ["-c", touch], { cwd: dir }));
check("promisified exec command", (touch) => execAsync(touch + " \u0000 x", { cwd: dir }));
check("promisified exec", (touch) => execAsync(touch, { cwd: dir }));

await Promise.all(running);
const markers = new Set(readdirSync(dir));
console.log("children started:");
for (let i = 0; i < labels.length; i++) {
  if (markers.has("marker" + i)) console.log(" ", labels[i]);
}
console.log("reported:");
for (const label of labels) {
  const what = reported.get(label);
  if (what !== undefined) console.log(" ", label, what);
}
rmSync(dir, { recursive: true, force: true });
