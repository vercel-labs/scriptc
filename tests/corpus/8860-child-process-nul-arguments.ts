// child_process checks what it hands to the operating system before it
// starts a process: a NUL in the file or command, an argument, cwd or an
// environment key or value throws ERR_INVALID_ARG_VALUE, and so does an
// empty file. The operating system would read each string up to its first
// NUL, so the child would get different text from what the program checked.
// Every launch here would create a marker file; a refused launch leaves none.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scriptc-nul-"));
const env = { PATH: process.env["PATH"] ?? "" };
let count = 0;

function check(label: string, launch: (touch: string) => unknown): void {
  const name = "marker" + count++;
  let outcome: string;
  try {
    launch("touch " + name);
    outcome = "returned";
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    outcome = ["threw", e.name, e.code, JSON.stringify(e.message.split(dir).join("<dir>"))].join(" ");
  }
  console.log(label, outcome, "| child started:", existsSync(join(dir, name)));
}

function note(text: string): string[] {
  console.log("  evaluated", text);
  return [];
}

// execFileSync
check("execFileSync argument", (touch) => execFileSync("sh", ["-c", touch, "a\u0000b"], { cwd: dir }));
check("execFileSync first argument", (touch) => execFileSync("sh", ["\u0000-c", touch], { cwd: dir }));
check("execFileSync file", (touch) => execFileSync("sh\u0000x", ["-c", touch], { cwd: dir }));
check("execFileSync empty file", (touch) => execFileSync("", ["-c", touch], { cwd: dir }));
check("execFileSync env value", (touch) => execFileSync("sh", ["-c", touch], { cwd: dir, env: { ...env, A: "x\u0000y" } }));
check("execFileSync env key", (touch) => execFileSync("sh", ["-c", touch], { cwd: dir, env: { ...env, ["A\u0000B"]: "1" } }));
check("execFileSync cwd", (touch) => execFileSync("sh", ["-c", touch], { cwd: dir + "\u0000/x" }));
check("execFileSync file before argument", (touch) => execFileSync("sh\u0000x", ["-c", touch, "a\u0000b"], { cwd: dir }));
check("execFileSync argument before cwd", (touch) => execFileSync("sh", ["-c", touch, "a\u0000b"], { cwd: dir + "\u0000/x" }));
check("execFileSync cwd before env", (touch) =>
  execFileSync("sh", ["-c", touch], { cwd: dir + "\u0000/x", env: { ...env, A: "x\u0000y" } }));
check("execFileSync", (touch) => execFileSync("sh", ["-c", touch], { cwd: dir }));

// execSync
check("execSync command", (touch) => execSync(touch + " \u0000 x", { cwd: dir }));
check("execSync empty command", () => execSync("", { cwd: dir }));
check("execSync env value", (touch) => execSync(touch, { cwd: dir, env: { ...env, A: "x\u0000y" } }));
check("execSync cwd", (touch) => execSync(touch, { cwd: dir + "\u0000/x" }));
check("execSync", (touch) => execSync(touch, { cwd: dir }));

// spawnSync
check("spawnSync argument", (touch) => spawnSync("sh", ["-c", touch, "a\u0000b"], { cwd: dir }));
check("spawnSync file", (touch) => spawnSync("sh\u0000x", ["-c", touch], { cwd: dir }));
check("spawnSync file, no options", () => spawnSync("sh\u0000x", ["-c", "exit 0"]));
check("spawnSync empty file", (touch) => spawnSync("", ["-c", touch], { cwd: dir }));
check("spawnSync env value", (touch) => spawnSync("sh", ["-c", touch], { cwd: dir, env: { ...env, A: "x\u0000y" } }));
check("spawnSync cwd", (touch) => spawnSync("sh", ["-c", touch], { cwd: dir + "\u0000/x" }));
check("spawnSync shell command", (touch) => spawnSync(touch + " \u0000 x", [], { cwd: dir, shell: true }));
check("spawnSync", (touch) => spawnSync("sh", ["-c", touch], { cwd: dir }));

// the argument expressions are evaluated before the check
check("spawnSync argument expressions", () => spawnSync("sh\u0000x", note("the argument list"), { cwd: dir }));

// how the received value is printed
check("quotes", (touch) => execFileSync("sh", ["-c", touch, "it's\u0000"], { cwd: dir }));
check("both quotes", (touch) => execFileSync("sh", ["-c", touch, "it's \"\u0000\""], { cwd: dir }));
check("long", (touch) => execFileSync("sh", ["-c", touch, "\u0000" + "0123456789".repeat(14)], { cwd: dir }));
check("lines", (touch) => execFileSync("sh", ["-c", touch, "first\nsecond\u0000\n" + "0123456789".repeat(7)], { cwd: dir }));
check("short lines", (touch) => execFileSync("sh", ["-c", touch, "first\nsecond\u0000"], { cwd: dir }));
check("above U+FFFF", (touch) => execFileSync("sh", ["-c", touch, "\u0000" + "\u{1f600}".repeat(70)], { cwd: dir }));

rmSync(dir, { recursive: true, force: true });
