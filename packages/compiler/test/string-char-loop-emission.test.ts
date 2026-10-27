import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("character reads of ASCII strings in versioned loops read bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-char-loops-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(
      entry,
      `
function spaces(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === " ") n++;
  return n;
}
function letters(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c >= "a" && c <= "z") n++;
  }
  return n;
}
function chars(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charAt(i));
  return out;
}
console.log(spaces("a b c"), letters("abC1z"), chars("xyz").join("-"), chars("é!").join("-"));
`,
    );
    const outPath = join(dir, "main.ir.json");
    const lowered = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!lowered.ok)
      throw new Error(lowered.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const ll = emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    const body = (name: string): string =>
      ll.match(
        new RegExp(`define internal [^\\n]+ @sc_bf_${name}\\([^\\n]*\\) #0 \\{[\\s\\S]*?\\n\\}`),
      )![0];
    // The byte copy follows the checked one, and the units copy (for
    // strings that are not ASCII) follows it.
    const fast = (fn: string): string => {
      const units = fn.search(/^bytes\.version\.fast\.units\d+:/m);
      return fn.slice(fn.search(/^bytes\.version\.fast\d+:/m), units < 0 ? undefined : units);
    };

    // `s[i] === " "` compares the byte; the checked copy keeps the helper.
    const spaces = body("spaces");
    expect(fast(spaces)).toMatch(/load i8, ptr %\S+\n\s+%\S+ = uitofp i8/);
    expect(fast(spaces)).not.toContain("@sc_str_char_code_at_int");
    expect(spaces).toContain("@sc_str_char_code_at_int");
    // A character local compared with one-unit literals holds its unit.
    const letters = body("letters");
    expect(letters).not.toContain("@sc_str_cmp_u16");
    expect(fast(letters)).toMatch(/load i8, ptr %\S+\n\s+%\S+ = uitofp i8/);
    // A character used as a string is its immortal table entry.
    const chars = body("chars");
    expect(fast(chars)).toContain("@sc_ascii_chars");
    expect(fast(chars)).not.toContain("@sc_str_char_at_int");
    expect(chars).toContain("@sc_str_char_at_int");

    const exe = join(dir, "main");
    const built = await compile(entry, { outputKind: "exe", outDir: dir, outPath: exe });
    if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
    expect(execFileSync(exe, { encoding: "utf8" })).toBe("2 3 x-y-z é-!\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
