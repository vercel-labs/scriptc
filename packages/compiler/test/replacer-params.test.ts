import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { regexLiteralCaptures } from "../src/backend/llvm/regex-matchers.js";
import { regexCaptureParticipation } from "../src/frontend/lowering/containers/replacer-params.js";

// The frontend binds a replace callback parameter as a string only for a
// capture every match sets; the backend then calls the callback directly
// only when its own parse agrees.
describe("replace callback captures", () => {
  test("never claims a capture the backend's parse can leave unset", () => {
    const patterns = [
      "(\\w+)=(\\d)+",
      "(?<k>a)(b)?|(c)",
      "x(?:(a)|(b))y(c)*(d){0,2}(e){1,3}",
      "((a)(b)?)+",
      "(a(b|c))d",
      "(?:a|(b))(c)",
    ];
    for (const pattern of patterns) {
      const frontend = regexCaptureParticipation(pattern, "");
      const backend = regexLiteralCaptures(pattern, "");
      expect(frontend?.count).toBe(backend?.count);
      frontend!.always.forEach((always, index) => {
        if (always) expect(backend!.always[index]).toBe(true);
      });
    }
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-replacer-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

/** The (arity, kinds) arguments of each direct replacer call, and the
 * number of calls through the boxed argument array. */
function replacerCalls(llvm: string): { direct: string[]; boxed: number } {
  const lines = llvm.split("\n").filter((line) => line.includes("call "));
  return {
    direct: lines
      .filter((line) => line.includes("@scr_regex_replace_fn("))
      .map((line) => /i32 (-?\d+), i32 (-?\d+), i1/.exec(line)!.slice(1, 3).join(":")),
    boxed: lines.filter((line) => line.includes("@scr_regex_replace_callback(")).length,
  };
}

describe("replace callback calls", () => {
  test("unannotated parameters take the kinds the replace passes", async () => {
    const llvm = await emit(`
const vars: Record<string, string> = { a: "1" };
const text = String(Date.now() > 0 ? "{a} {b}" : "");
console.log(text.replace(/\\{(\\w+)\\}/g, (_m, key) => vars[key] ?? ""));
console.log(text.replace(/\\{(\\w)/g, (_m, c) => c.toUpperCase()));
console.log(text.replace(/(a)|(b)/g, (m, a, b) => \`\${m}\${a}\${b}\`));
console.log(text.replace(/(a)(b)?/g, (m: string, a: string, b: string | undefined, at: number) => m + a + (b ?? "") + at));
const half = (n: number): number => n / 2;
console.log(text.replace(/b/g, (m, at) => String(half(at))));
console.log(text.replace(/b/g, (m, at) => String(parseFloat(at) + parseInt(at))));
console.log(text.replace(/(\\d)/g, (m, d) => String(parseInt("11", d))));
console.log(text.replace(/(a)(b)(c)/g, (m, a, b, c, at, all, extra) => m + a + b + c + at + all + extra));
`);
    expect(replacerCalls(llvm)).toEqual({
      // Typed parameters and result (0); a checked-dynamic result (bit 31);
      // two captures a match can leave unset (bits 1 and 2);
      // \`string | undefined\` at capture 2 (bit 8 + 2); an offset passed to a
      // number parameter keeps its checked-dynamic box (bit 1).
      // parseFloat and parseInt take text, and parseInt's radix is a
      // number: the offset passed as text and the capture passed as the
      // radix stay checked-dynamic (bit 1), so both calls compile.
      direct: ["2:0", "2:-2147483648", "3:6", "4:1024", "2:2", "2:2", "2:2"],
      // Seven parameters exceed the direct calls' limit.
      boxed: 1,
    });
  });
});
