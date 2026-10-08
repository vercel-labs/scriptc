import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("generic family narrowing validates the requested payload layout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-generic-recovery-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(
      entry,
      `
class Base { id = 0; }
class Cell<T> extends Base { value: T; constructor(value: T) { super(); this.value = value; } }
function recover<T>(base: Base): Cell<T> | undefined {
  return base instanceof Cell ? base : undefined;
}
const text = new Cell<string>("intact");
try {
  const wrong = recover<number>(text);
  if (wrong) wrong.value = 42;
  console.log("unexpected");
} catch (error) {
  console.log(error instanceof TypeError, text.value);
}
console.log(recover<string>(text) === text, recover<number>(new Cell<number>(7))?.value);
`,
    );
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      backend: "llvm",
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("true intact\ntrue 7\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
