import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../../index.js";
import type { IrModule } from "../../ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-string-index-bounds-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: dir,
      outPath: output,
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Functions whose string element reads keep the optional (checked) form. */
function optionalReads(module: IrModule): Set<string> {
  return new Set(
    module.functions
      .filter((fn) => fn.locals.some((local) => local.name === "%indexedString"))
      .map((fn) => fn.name),
  );
}

const PROVEN = `
function upward(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += s[i];
  return out;
}
function downward(s: string): string {
  let out = "";
  for (let i = s.length - 1; i >= 0; i--) out += s[i];
  return out;
}
function stepped(s: string): string {
  let out = "";
  for (let i = 1; i < s.length; i += 2) out += s[i];
  return out;
}
function scanned(s: string): number {
  let words = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " ") { i++; continue; }
    while (i < s.length && s[i] !== " ") i++;
    words++;
  }
  return words;
}
function exitFirst(s: string): string {
  let i = 0;
  while (true) {
    if (i >= s.length) return "";
    if (s[i] !== " ") return s[i];
    i++;
  }
}
function aliased(s: string): number {
  const n = s.length;
  let count = 0;
  for (let i = 0; i < n; i++) if (s[i] === "a") count++;
  return count;
}
function inclusive(s: string): number {
  let count = 0;
  for (let i = 0; i <= s.length - 1; i++) if (s[i] === "b") count++;
  return count;
}
function choice(s: string): string {
  const i = 2;
  return i < s.length ? s[i] : "-";
}
function negated(s: string): string {
  let i = 0;
  if (!(i < s.length)) return "-";
  return s[i];
}
function trimmed(s: string): number {
  let end = s.length - 1;
  while (end >= 0 && s[end] === " ") end--;
  return end + 1;
}
function nested(text: string): number {
  const count = (): number => {
    let k = 0;
    for (let i = 0; i < text.length; i++) if (text[i] === "x") k++;
    return k;
  };
  return count() + count();
}
console.log(upward("ab"), downward("ab"), stepped("abcd"), scanned("a b"), exitFirst(" q"));
console.log(aliased("aa"), inclusive("bb"), choice("abc"), negated("z"), trimmed("a "), nested("x"));
`;

const UNPROVEN = `
function bumped(s: string): string | undefined {
  let i = 0;
  if (i < s.length) { i++; return s[i]; }
  return "";
}
function innerLoop(s: string): string {
  let out = "";
  let i = 0;
  if (i < s.length) for (let k = 0; k < 3; k++) { out += String(s[i]); i++; }
  return out;
}
function replaced(s: string): string | undefined {
  let t = s;
  const i = 1;
  if (i < t.length) { t = ""; return t[i]; }
  return "";
}
function capturedText(s: string): string {
  let t = s;
  const clear = (): void => { t = ""; };
  let out = "";
  for (let i = 0; i < t.length; i++) { clear(); out += String(t[i]); }
  return out;
}
function capturedIndex(s: string): string {
  let i = 0;
  const skip = (): void => { i += 5; };
  let out = "";
  while (i < s.length) { skip(); out += String(s[i]); }
  return out;
}
function fractional(s: string): string | undefined {
  const i = 0.5;
  return i < s.length ? s[i] : "";
}
function negative(s: string): string | undefined {
  const i = -1;
  return i < s.length ? s[i] : "";
}
function pastEnd(s: string): string {
  let out = "";
  for (let i = 0; i <= s.length; i++) out += String(s[i]);
  return out;
}
function otherText(s: string, t: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += String(t[i]);
  return out;
}
function parameterIndex(s: string, i: number): string | undefined {
  return i < s.length ? s[i] : "";
}
function afterLoop(s: string): string | undefined {
  let i = 0;
  do { i++; } while (i < s.length);
  return s[i];
}
function unguarded(s: string): string | undefined {
  const i = 0;
  return s[i];
}
console.log(bumped("a"), innerLoop("ab"), replaced("ab"), capturedText("ab"), capturedIndex("ab"));
console.log(fractional("a"), negative("a"), pastEnd("a"), otherText("abc", "a"), parameterIndex("a", 0.5));
console.log(afterLoop("ab"), unguarded(""));
`;

test("proven in-bounds string element reads lower to plain strings", async () => {
  const module = await lower(PROVEN);
  const names = [
    "upward",
    "downward",
    "stepped",
    "scanned",
    "exitFirst",
    "aliased",
    "inclusive",
    "choice",
    "negated",
    "trimmed",
    "nested",
  ];
  for (const name of names)
    expect(
      module.functions.some((fn) => fn.name === name),
      name,
    ).toBe(true);
  expect([...optionalReads(module)]).toEqual([]);
});

test("reads without a bounds proof keep the optional result", async () => {
  const module = await lower(UNPROVEN);
  const optional = optionalReads(module);
  for (const name of [
    "bumped",
    "innerLoop",
    "replaced",
    "capturedText",
    "capturedIndex",
    "fractional",
    "negative",
    "pastEnd",
    "otherText",
    "parameterIndex",
    "afterLoop",
    "unguarded",
  ])
    expect(optional.has(name), name).toBe(true);
});

test("a callee keeps a plain string parameter when every caller is proven", async () => {
  const module = await lower(`
function isDigit(ch: string): boolean { return ch >= "0" && ch <= "9"; }
function isUpper(ch: string): boolean { return ch >= "A" && ch <= "Z"; }
function count(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (isDigit(text[i])) n++;
  return n;
}
function peekUpper(text: string, at: number): boolean { return isUpper(text[at]); }
console.log(count("a1b2"), peekUpper("Ab", 0), peekUpper("Ab", 9));
`);
  const param = (name: string) => module.functions.find((fn) => fn.name === name)!.params[0]!.type;
  expect(param("isDigit")).toEqual({ kind: "string" });
  expect(param("isUpper").kind).toBe("union");
});
