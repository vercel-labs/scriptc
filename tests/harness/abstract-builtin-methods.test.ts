import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// An abstract re-declaration emits no prototype member, so a call through
// one that no program class implements reaches what the prototype chain
// has above it. When a built-in supplies the method there (Object.prototype,
// or the Array or Date method under `extends Array` / `extends Date`), the
// call does not throw in Node. A typed direct call is refused at build time
// (tests/diagnostics/abstract-builtin-method-calls.ts). These programs reach
// the method where the build cannot see it: each BUILDS, and the reach either
// answers as Node does or throws a refusal, never Node's "is not a function"
// TypeError, which Node does not throw here.
async function run(source: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-abstract-builtin-methods-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return "";
  const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  return stdout;
}

const attempt = `function attempt(label: string, run: () => unknown): void {
  try { console.log(label, run()); }
  catch (error) { console.log(label, "threw", (error as Error).message, (error as { code?: string }).code); }
}
`;

test("an untyped call of a built-in method behind an abstract re-declaration does not throw a TypeError", async () => {
  const stdout = await run(`${attempt}
abstract class Shown { abstract toString(): string; }
abstract class Joined extends Array<number> { abstract join(separator?: string): string; }
abstract class Timed extends Date { abstract getTime(): number; abstract toISOString(): string; }
abstract class Nothing { abstract label(): string; }
const shown: any = new (Shown as any)();
const joined = new (Joined as any)() as Joined;
joined.push(1, 2);
const untypedJoined: any = joined;
const timed: any = new (Timed as any)(5);
const typedTimed = timed as Timed;
const nothing: any = new (Nothing as any)();
attempt("toString", () => shown.toString());
attempt("join", () => untypedJoined.join("-"));
attempt("element join", () => joined["join"]("+"));
attempt("getTime", () => timed.getTime());
attempt("toISOString", () => timed.toISOString());
attempt("element getTime", () => typedTimed["getTime"]());
attempt("label", () => nothing.label());
`);
  expect(stdout.split("\n")).toEqual([
    "toString [object Object]",
    "join 1-2",
    "element join 1+2",
    "getTime threw reading 'getTime' on this native class through an untyped value is not supported yet SC2020",
    "toISOString threw reading 'toISOString' on this native class through an untyped value is not supported yet SC2020",
    "element getTime threw reading 'getTime' on this native class through an untyped value is not supported yet SC2020",
    // Nothing supplies it: Node's TypeError.
    "label threw nothing.label is not a function undefined",
    "",
  ]);
});
