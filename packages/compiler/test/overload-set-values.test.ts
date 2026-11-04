/* A value of an overload-set type holds ONE stored function whose result
 * joins the overloads'; each call converts that result to the resolved
 * overload's type, and the conversion is CHECKED. An implementation that
 * lies through `any` (returns its string input where the resolved overload
 * promises a number) throws the catchable TypeError the types-don't-lie
 * stance promises, both through an overloaded member and through an
 * overloaded value. Node erases the types, so the lying program diverges
 * on purpose and is not a corpus case; the conforming shapes are pinned by
 * tests/corpus/8937-overload-set-values. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<ReturnType<typeof spawnSync>> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-overload-values-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const built = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!built.ok) throw new Error(built.diagnostics.map((d) => d.message).join("\n"));
    return spawnSync(built.binaryPath, [], { timeout: 30_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")(
  "a lying implementation behind an overload set throws at the converted result",
  async () => {
    const result = await run(`
interface Parse {
  parse(text: string): number;
  parse(value: number): string;
}
type Format = { (value: string): number; (value: number): string };
const lying: Parse = { parse: ((input: any) => input) as any };
const lyingFormat = ((input: any) => input) as unknown as Format;
try {
  const n: number = lying.parse("five");
  console.log("member returned", typeof n);
} catch (err) {
  console.log("member threw", (err as Error).name);
}
try {
  const n: number = lyingFormat("five");
  console.log("value returned", typeof n);
} catch (err) {
  console.log("value threw", (err as Error).name);
}
const honest: Format = (input: any): any => (typeof input === "string" ? input.length : String(input));
console.log(honest("four") + 1, honest(7).length);
console.log("survived");
`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe(
      "member threw TypeError\nvalue threw TypeError\n5 1\nsurvived\n",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "an optional call through an overload set converts the resolved overload's result",
  async () => {
    const result = await run(`
type Parse = { (text: string): number; (value: number): string };
const parse: Parse = (input: any): any => (typeof input === "string" ? input.length : \`#\${input}\`);
function lengths(p: Parse | undefined): void {
  const n = p?.("four");
  const s = p?.(7);
  console.log(n, s);
}
lengths(parse);
lengths(undefined);
interface Picker {
  pick(kind: "s"): string;
  pick(kind: "n"): number;
}
const picker: Picker = { pick(kind: "s" | "n"): any { return kind === "s" ? "str" : 41; } };
const maybe: Picker | undefined = picker;
console.log(maybe?.pick?.("s"), maybe?.pick?.("n"));
function none(p: Picker | undefined): string { return String(p?.pick?.("s")); }
console.log(none(undefined));
// The converted result is still checked, inside the guard: a lying
// implementation behind the optional call throws where the resolved
// overload promises another scalar.
const lying = ((input: any) => input) as unknown as Parse;
try {
  const n: number = lying?.("five") ?? 0;
  console.log("returned", n);
} catch (err) {
  console.log("threw", (err as Error).name);
}
console.log("survived");
`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe(
      "4 #7\nundefined undefined\nstr 41\nundefined\nthrew TypeError\nsurvived\n",
    );
  },
);
