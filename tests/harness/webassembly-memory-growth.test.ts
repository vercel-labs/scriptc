/* WebAssembly memory growth while JavaScript holds views of the buffer —
 * scriptc-only.
 *
 * Node detaches the previous ArrayBuffer when a memory grows (its views
 * read as empty). scriptc does not detach it yet: the previous buffer and
 * its views keep their length and keep aliasing the memory's storage,
 * which therefore never moves, also in the explicitly bounds-checked
 * configuration (sanitized builds, Windows) that has no guard pages. These
 * pins check that writes through an old view and through the guest reach
 * the same storage after growth, from JavaScript and from the guest.
 * Under SCRIPTC_SAN=1 an access through a view of moved storage is an
 * AddressSanitizer report.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

// (module
//   (memory (export "memory") 1 64)
//   (func (export "grow") (param i32) (result i32) (memory.grow (local.get 0)))
//   (func (export "poke") (param i32 i32) (i32.store8 (local.get 0) (local.get 1)))
//   (func (export "peek") (param i32) (result i32) (i32.load8_u (local.get 0))))
const growthModule =
  "AGFzbQEAAAABCwJgAX8Bf2ACf38AAwQDAAEABQQBAQFABx8EBm1lbW9yeQIABGdyb3cAAARwb2tlAAEEcGVlawACChoDBgAgAEAACwkAIAAgAToAAAsHACAALQAACw==";

async function run(name: string, source: string): Promise<string> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `wasm-growth-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.mjs`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  return stdout;
}

describe(`WebAssembly memory growth with live views${sanitize ? " (sanitized)" : ""}`, () => {
  test("Memory.prototype.grow keeps earlier views on the memory's storage", async () => {
    const out = await run(
      "js-growth",
      `const bytes = Buffer.from("${growthModule}", "base64");
const { memory } = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
const view = new Uint8Array(memory.buffer);
view[0] = 7;
for (let i = 0; i < 40; i++) memory.grow(1);
view[1] = 9;
const now = new Uint8Array(memory.buffer);
now[2] = 11;
console.log(view.length, now.length, now[0], now[1], view[2]);
`,
    );
    expect(out).toBe("65536 2686976 7 9 11\n");
  }, 180_000);

  test("memory.grow in the guest keeps earlier views on the memory's storage", async () => {
    const out = await run(
      "guest-growth",
      `const bytes = Buffer.from("${growthModule}", "base64");
const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes));
const view = new Uint8Array(exports.memory.buffer);
view[0] = 7;
let pages = 0;
for (let i = 0; i < 40; i++) pages = exports.grow(1);
view[1] = 9;
exports.poke(2, 11);
const now = new Uint8Array(exports.memory.buffer);
console.log(pages, view.length, now.length, exports.peek(0), exports.peek(1), view[2], now[2]);
`,
    );
    expect(out).toBe("40 65536 2686976 7 9 11 11\n");
  }, 180_000);
});
