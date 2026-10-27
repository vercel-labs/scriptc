import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { literalCapWord } from "../src/backend/llvm/string-key-hash.js";
import type { IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-char-at-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    return mod;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const options = { targetTriple: "x86_64-unknown-linux-gnu", pointerBits: 64 } as const;

test("charAt reads proven-ASCII strings through the module's character table", async () => {
  const mod = await lower(
    'const s = process.argv.length > 9 ? "x" : "hello";\nconst i: number = process.argv.length - 1;\nconsole.log(s.charAt(i), s[i]);\n',
  );
  const ir = emitLlvmModule(mod, options);
  expect(ir).toContain("define internal ptr @sc_str_char_at(ptr %s, double %i)");
  expect(ir).toContain("call ptr @scr_str_char_at(ptr %s, double %i) cold");
  // Each entry is an immortal one-character literal with the runtime's
  // capacity word (length, proven-ASCII bit and key hash).
  const word = literalCapWord(new Uint8Array([65]));
  expect(ir).toContain(`{ i64 -1, i64 1, i64 ${word}, [2 x i8] [i8 65, i8 0] }`);
  expect(ir.match(/^@sc_ascii_chars = internal constant \[128 x /gm)).toHaveLength(1);
});

test("charAt at a counted-loop index uses the integer helper", async () => {
  const mod = await lower(
    'const s = process.argv.length > 9 ? "x" : "hello";\nlet out = "";\nfor (let i = 0; i < s.length; i++) out += s.charAt(i);\nconsole.log(out);\n',
  );
  const ir = emitLlvmModule(mod, options);
  expect(ir).toContain("define internal ptr @sc_str_char_at_int(ptr %s, i64 %i)");
  expect(ir).toMatch(/call ptr @sc_str_char_at_int\(ptr %\w+, i64 %\w+\)/);
});

test("programs without charAt carry no character table", async () => {
  const mod = await lower('console.log("hello".length + process.argv.length);\n');
  expect(emitLlvmModule(mod, options)).not.toContain("@sc_ascii_chars");
});
