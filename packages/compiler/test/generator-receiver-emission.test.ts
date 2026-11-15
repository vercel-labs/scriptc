/* A generator body reads `this` on the generator's fiber, after the call
 * that made it returned, so the spawn wrapper records the call's receiver
 * (scr_gen_capture_receiver). Only a program with such a read does: a
 * generator of typed code records nothing, and its executable links no
 * dynamic receiver read. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(name: string, source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-gen-receiver-"));
  directories.push(outDir);
  const entry = join(outDir, name);
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

test("a typed generator records no receiver", async () => {
  const llvm = await emit(
    "main.ts",
    `function* count(n: number): Generator<number, void, undefined> {
  for (let i = 0; i < n; i++) yield i;
}
let sum = 0;
for (const v of count(4)) sum += v;
console.log(sum);
`,
  );
  expect(llvm).toContain("@scr_gen_new");
  expect(llvm).not.toContain("scr_gen_capture_receiver");
  expect(llvm).not.toContain("scr_gen_receiver");
});

test("a JavaScript generator that reads this records the call's receiver", async () => {
  const llvm = await emit(
    "main.js",
    `"use strict";
const counter = {
  base: 10,
  *count(n) {
    for (let i = 0; i < n; i++) yield this.base + i;
  },
};
console.log([...counter.count(3)].join(","));
`,
  );
  expect(llvm).toMatch(/call void @scr_gen_capture_receiver\(ptr %gg\)/);
  expect(llvm).toContain("@scr_gen_receiver");
});
