import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-completion-callbacks-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

const randomBytes = `
import { randomBytes } from "node:crypto";
randomBytes(4, (error, buffer) => console.log(error === null, buffer.length));
`;

test("programs without AsyncLocalStorage pass completion callbacks unchanged", async () => {
  const llvm = await emit(randomBytes);
  expect(llvm).not.toContain("@scr_als_bind_closure");
  expect(llvm).not.toContain("sc_alsbound_");
});

test("programs that enter stores bind each completion callback to the active context", async () => {
  const llvm = await emit(`
import { AsyncLocalStorage } from "node:async_hooks";
${randomBytes}
const store = new AsyncLocalStorage<string>();
store.run("a", () => randomBytes(1, (error, buffer) => console.log(store.getStore(), buffer.length)));
`);
  const binds = llvm.match(
    /call ptr @scr_als_bind_closure\(ptr [^,]+, ptr @sc_alsbound_\d+, i1 false\)/g,
  );
  expect(binds?.length).toBe(2);
  // One thunk per callback signature.
  expect(llvm.match(/^define internal void @sc_alsbound_\d+\(/gm)?.length).toBe(1);
});

test("AsyncLocalStorage.bind binds a typed function with an empty context too", async () => {
  const llvm = await emit(`
import { AsyncLocalStorage } from "node:async_hooks";
const store = new AsyncLocalStorage<string>();
const read = AsyncLocalStorage.bind((n: number) => \`\${store.getStore()} \${n}\`);
console.log(store.run("x", () => read(1)));
`);
  expect(llvm).toMatch(
    /call ptr @scr_als_bind_closure\(ptr [^,]+, ptr @sc_alsbound_\d+, i1 true\)/,
  );
  expect(llvm).toMatch(/^define internal ptr @sc_alsbound_\d+\(ptr %self, double %a0\)/m);
});
