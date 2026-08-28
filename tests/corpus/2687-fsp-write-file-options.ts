// Static three-argument fs/promises.writeFile: utf8's string and object
// spellings, creation mode (which does not re-apply to existing files),
// safely ignored option values, and syscall failures delivered as promise
// rejections.
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-fsp-write-"));
const encoded = join(dir, "encoded.txt");
const modeFile = join(dir, "mode.txt");

let evaluations: string[] = [];
function encoding(label: string): "utf8" {
  evaluations.push(label);
  return "utf8";
}
function mode(label: string): number {
  evaluations.push(label);
  return 0o600;
}
function writePath(label: string): string {
  evaluations.push(label);
  return encoded;
}
function writeData(label: string, value: string): string {
  evaluations.push(label);
  return value;
}

await writeFile(encoded, "first", "utf-8");
await writeFile(encoded, "second", { encoding: "utf8" });
console.log("encoded:", readFileSync(encoded, "utf8"));

await writeFile(writePath("path"), writeData("data", "bare effect"), encoding("bare"));
await writeFile(encoded, "encoding first", { encoding: encoding("encoding"), mode: mode("mode") });
await writeFile(encoded, "mode first", { mode: mode("mode"), encoding: encoding("encoding") });
console.log("evaluated:", evaluations.join(","), readFileSync(encoded, "utf8"));

// Undocumented values that cannot have effects stay dropped rather than
// being lowered themselves. Primitive __proto__ values are also ignored by
// JavaScript's special object-literal setter, so they do not need the
// prototype-backed-options fence.
writeFileSync(encoded, "sync ignored", {
  ignored: <T>(value: T): T => value,
  __proto__: 1,
});
await writeFile(encoded, "promise ignored", {
  ignored: <T>(value: T): T => value,
  __proto__: "primitive",
});
console.log("ignored:", readFileSync(encoded, "utf8"));

await writeFile(modeFile, "created", { mode: 0o600, encoding: "utf-8" });
accessSync(modeFile, constants.W_OK);
await writeFile(modeFile, "rewritten", { mode: 0o400 });
accessSync(modeFile, constants.W_OK);
console.log("mode:", readFileSync(modeFile, "utf8"));

try {
  const rejected = writeFile(join(dir, "missing", "file.txt"), "x", { mode: 0o600 });
  console.log("promise returned");
  await rejected;
  console.log("no rejection");
} catch (e) {
  if (e instanceof Error) {
    console.log("rejected:", `${(e as NodeJS.ErrnoException).code}`, e.message.includes("open"));
  }
}

async function invalidMode(label: string, value: number): Promise<void> {
  const path = join(dir, `${label}.txt`);
  try {
    const rejected = writeFile(path, "x", { mode: value });
    console.log(label, "promise returned");
    await rejected;
    console.log(label, "resolved", existsSync(path));
  } catch (e) {
    if (e instanceof Error) {
      console.log(label, e.name, `${(e as NodeJS.ErrnoException).code}`, existsSync(path));
    }
  }
}

await invalidMode("negative", -1);
await invalidMode("fractional", 1.5);
await invalidMode("nan", NaN);

rmSync(dir, { recursive: true, force: true });
console.log("done:", !existsSync(dir));
