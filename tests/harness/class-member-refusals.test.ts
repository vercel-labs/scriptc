import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// A class member that cannot be compiled is refused without rejecting its
// class (class-member-refusals.ts). A statically typed use is a build
// error (tests/diagnostics/class-member-refusals.ts). These programs reach
// the member where the build cannot see it: each BUILDS, and the reach
// throws the member's refusal with its diagnostic code at run time.
async function run(source: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-class-member-refusals-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", stderr: "", code: -1 };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? -1 };
  }
}

/** The refusal text without the source position of the generated program. */
function lines(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.replace(/ \[(SC\d+) at [^\]]*\]/, " [$1]"));
}

const attempt = `function attempt(label: string, run: () => unknown): void {
  try { console.log(label, run()); }
  catch (error) { console.log(label, "threw", (error as Error).message, (error as { code?: string }).code); }
}
`;

test("a refused method reached through an untyped value throws its refusal", async () => {
  const { stdout, stderr, code } = await run(`${attempt}
class Store {
  count = 0;
  watch(ref: WeakRef<object>): number { return ref.deref() === undefined ? 0 : 1; }
  add(): number { return ++this.count; }
}
const store = new Store();
const untyped: any = store;
console.log(store.add(), typeof untyped.watch, "watch" in untyped, untyped.add());
attempt("call", () => untyped.watch({}));
const detached = untyped.watch;
attempt("detached", () => detached.call(store, {}));
console.log(store.count);
`);
  expect(lines(stdout)).toEqual([
    "1 function true 2",
    "call threw 'WeakRef<object>' is part of the standard library types but has no scriptc lowering yet [SC2020] SC2020",
    "detached threw 'WeakRef<object>' is part of the standard library types but has no scriptc lowering yet [SC2020] SC2020",
    "2",
    "",
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("a refused override reached through its base class or an interface throws its refusal", async () => {
  const { stdout, stderr, code } = await run(`${attempt}
interface Output { print(text: string, copies: number): string; }
class Printer implements Output {
  sheets = 1;
  print(text: string, copies: number): string { return "printer " + text + " x" + copies + " " + this.sheets; }
}
class Plotter extends Printer {
  print(): string { return "plotter " + arguments.length; }
  twice(): number { return this.sheets * 2; }
}
function viaBase(p: Printer): string { return p.print("a", 2); }
function viaInterface(o: Output): string { return o.print("b", 3); }
attempt("base", () => viaBase(new Printer()));
attempt("sub", () => viaBase(new Plotter()));
attempt("interface base", () => viaInterface(new Printer()));
attempt("interface sub", () => viaInterface(new Plotter()));
console.log(new Plotter().twice());
`);
  const refusal =
    "threw overriding a method with a different signature (parameter types must match the base declaration exactly; returns may narrow to a subclass) is not supported yet [SC1090] SC1090";
  expect(lines(stdout)).toEqual([
    "base printer a x2 1",
    `sub ${refusal}`,
    "interface base printer b x3 1",
    `interface sub ${refusal}`,
    "2",
    "",
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("a refused setter and a refused getter reached through an untyped value throw", async () => {
  const { stdout, stderr, code } = await run(`${attempt}
class Cell {
  private raw = "1";
  get v(): string { return this.raw; }
  set v(x: string | number) { this.raw = String(x); }
}
class Holder {
  n = 1;
  get held(): WeakRef<object> { throw new Error("never"); }
}
const cell: any = new Cell();
attempt("read", () => cell.v);
attempt("write", () => { cell.v = "2"; return cell.v; });
const holder: any = new Holder();
attempt("held", () => holder.held);
console.log(holder.n);
`);
  expect(lines(stdout)).toEqual([
    "read 1",
    "write threw getter/setter pairs with different types (the property 'v' must have one type) are not supported yet [SC1090] SC1090",
    "held threw 'WeakRef<object>' is part of the standard library types but has no scriptc lowering yet [SC2020] SC2020",
    "1",
    "",
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("an uncaught refusal ends the program with the member's diagnostic", async () => {
  const { stdout, stderr, code } = await run(`
class Printer { print(text: string): string { return text; } }
class Plotter extends Printer { print(): string { return "plotter " + arguments.length; } }
const all: Printer[] = [new Printer(), new Plotter()];
for (const each of all) console.log(each.print("a"));
`);
  expect(stdout).toBe("a\n");
  expect(stderr).toContain("overriding a method with a different signature");
  expect(stderr).toContain("SC1090");
  expect(code).not.toBe(0);
});
