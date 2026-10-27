/* The CompileError for WebAssembly bytes that have no translation —
 * scriptc-only.
 *
 * A module the build finds but does not translate (one that uses a
 * proposal outside the translated feature set, or an invalid one) rejects
 * with a CompileError that names the reason the build recorded. Bytes the
 * build did not see reject with the message for unseen bytes. Both stay
 * catchable CompileErrors, and WebAssembly.validate answers false for
 * them.
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

// (module (func i32.const 0 i8x16.splat drop))
const simdModule = "AGFzbQEAAAABBAFgAAADAgEACgkBBwBBAP0PGgs=";

const source = `const simd = Buffer.from("${simdModule}", "base64");
// A type section whose entry is not a function type, so the module is
// malformed.
const invalid = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 2, 1, 64]);
// A custom section whose last byte is computed when the program runs, so
// the build does not see these bytes.
const unseen = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 4, 2, 97, 98, process.argv.length]);
function load(label, bytes) {
  console.log(label, WebAssembly.validate(bytes));
  try {
    new WebAssembly.Module(bytes);
  } catch (e) {
    console.log(label, e instanceof WebAssembly.CompileError, e.message);
  }
}
load("simd", simd);
load("invalid", invalid);
load("unseen", unseen);
WebAssembly.compile(simd).catch((e) => console.log("compile", e instanceof WebAssembly.CompileError, e.message));
`;

async function run(): Promise<string> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `wasm-untranslated-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "untranslated.mjs");
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, "untranslated"),
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

describe(`WebAssembly modules without a translation${sanitize ? " (sanitized)" : ""}`, () => {
  test("the CompileError names why a module the build found is not translated", async () => {
    const lines = (await run()).trimEnd().split("\n");
    const found = (what: string, reason: string) =>
      `${what}: this module was found when the program was built but not translated (${reason}; see https://scriptc.dev/limitations)`;
    const unseen =
      "WebAssembly.Module(): this module was not translated when the program was built (scriptc compiles " +
      "WebAssembly ahead of time and cannot compile modules whose bytes it did not see; see https://scriptc.dev/limitations)";
    expect(lines[0]).toBe("simd false");
    expect(lines[1]).toBe(
      `simd true ${found("WebAssembly.Module()", "it uses simd, outside the translated WebAssembly feature set")}`,
    );
    expect(lines[2]).toBe("invalid false");
    expect(lines[3]).toBe(
      `invalid true ${found("WebAssembly.Module()", "it is not a valid module: malformed function type (at byte 12)")}`,
    );
    expect(lines[4]).toBe("unseen false");
    expect(lines[5]).toBe(`unseen true ${unseen}`);
    expect(lines[6]).toBe(
      `compile true ${found("WebAssembly.compile()", "it uses simd, outside the translated WebAssembly feature set")}`,
    );
    expect(lines).toHaveLength(7);
  }, 180_000);
});
