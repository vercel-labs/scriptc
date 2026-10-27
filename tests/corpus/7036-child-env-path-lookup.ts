// spawn and execFileSync with an env option find the command on the
// replacement environment's PATH, or on the default path when it has
// none, as Node does; a relative PATH entry is read from the cwd option.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-child-path-"));
mkdirSync(join(dir, "tools"));
writeFileSync(join(dir, "tools", "child-tool"), "#!/bin/sh\necho child-tool $1\n");
chmodSync(join(dir, "tools", "child-tool"), 0o755);

// An earlier PATH entry holding a script whose interpreter is missing
// moves the lookup on to the next entry, as execvp does.
mkdirSync(join(dir, "broken"));
writeFileSync(join(dir, "broken", "child-tool"), "#!/nonexistent/interpreter\n");
chmodSync(join(dir, "broken", "child-tool"), 0o755);

const show = (e: unknown): string => {
  const err = e as NodeJS.ErrnoException;
  return `${err.code} ${err.message.replace(dir, "<dir>")}`;
};

console.log(execFileSync("child-tool", ["sync"], { env: { PATH: join(dir, "tools") }, encoding: "utf8" }).trim());
console.log(execFileSync("sh", ["-c", "echo default"], { env: { A: "1" }, encoding: "utf8" }).trim());
try {
  execFileSync("sh", ["-c", "echo never"], { env: { PATH: "/nonexistent" }, encoding: "utf8" });
} catch (e) {
  console.log(show(e));
}
const twoEntries = `${join(dir, "broken")}:${join(dir, "tools")}`;
console.log(execFileSync("child-tool", ["fallthrough"], { env: { PATH: twoEntries }, encoding: "utf8" }).trim());
try {
  execFileSync("child-tool", [], { env: { PATH: join(dir, "broken") }, encoding: "utf8" });
} catch (e) {
  console.log(show(e));
}
console.log(
  execFileSync("child-tool", ["relative"], { env: { PATH: "tools" }, cwd: dir, encoding: "utf8" }).trim(),
);

const child = spawn("child-tool", ["async"], { env: { PATH: twoEntries }, stdio: ["ignore", "pipe", "ignore"] });
let out = "";
child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
child.on("close", (code) => {
  console.log(out.trim(), code);
  const missing = spawn("sh", ["-c", "true"], { env: { PATH: "/nonexistent" }, stdio: "ignore" });
  missing.on("error", (e) => {
    console.log("error", show(e));
    rmSync(dir, { recursive: true });
  });
});
