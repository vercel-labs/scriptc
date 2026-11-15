/* A union value flowing into a record slot that is one of its own arms.
 *
 * Where the checker still sees the other arm at the site (`S | T` into `T`
 * with `S` assignable to `T`), that arm is a value of the slot's type and
 * converts on its own tag; tests/corpus/9481-async-return-then-payload.ts
 * and 9483-union-into-own-record-arm.ts pin those against Node.
 *
 * Where the checker typed the site as the arm itself, the value was
 * narrowed to it, and a value of another arm there is a lie: the checked
 * extraction still throws the catchable TypeError (divergence 38), even
 * when that arm's layout would convert. Node erases the claim and passes
 * the value on, so this is not a corpus case. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** Build one program: the names of its lowered functions, and the output
 * and exit status of the binary. */
async function build(source: string): Promise<{ names: string[]; stdout: string; status: number }> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-own-arm-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const irPath = join(dir, "main.ir.json");
    const lowered = await compile(entry, { outDir: dir, outPath: irPath, outputKind: "ir" });
    if (!lowered.ok) throw new Error(lowered.diagnostics.map((d) => d.message).join("\n"));
    const names = deserializeModule(readFileSync(irPath, "utf8")).functions.map((fn) => fn.name);
    const built = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!built.ok) throw new Error(built.diagnostics.map((d) => d.message).join("\n"));
    const result = spawnSync(built.binaryPath, [], { timeout: 30_000 });
    return { names, stdout: String(result.stdout), status: result.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const converting = (names: readonly string[]): string[] =>
  names.filter((name) => name.startsWith("%union.narrow.width."));

const NARROWED = `
type Plain = { kind: "plain"; n: number };
type Tagged = { kind: "tagged"; n: number; tag: string };
function takePlain(value: Plain): string {
  return value.kind + value.n;
}
function make(n: number): Plain | Tagged {
  return n > 0 ? { kind: "plain", n } : { kind: "tagged", n, tag: "t" };
}
// An assertion to the arm: the site's type is the arm.
function asserted(n: number): string {
  return takePlain(make(n) as Plain);
}
// A binding a callback reassigns after its discriminant was tested.
function stale(n: number): string {
  let value: Plain | Tagged = make(1);
  const swap = (): void => {
    value = make(n);
  };
  if (value.kind === "plain") {
    swap();
    return takePlain(value);
  }
  return "other";
}
for (const [name, run] of [
  ["asserted", () => asserted(1)],
  ["asserted lie", () => asserted(0)],
  ["stale", () => stale(1)],
  ["stale lie", () => stale(0)],
] as const) {
  try {
    console.log(name, run());
  } catch (error) {
    console.log(name, "threw", (error as Error).name);
  }
}
`;

test("a site the checker narrowed to the arm keeps the checked extraction", async () => {
  const program = await build(NARROWED);
  // `Tagged` has every member of `Plain`, so its layout would convert:
  // the site's type, not the layout, decides.
  expect(converting(program.names)).toEqual([]);
  expect(program.names.some((name) => name.startsWith("%union.narrow."))).toBe(true);
  expect(program.status).toBe(0);
  expect(program.stdout).toBe(
    "asserted plain1\nasserted lie threw TypeError\nstale plain1\nstale lie threw TypeError\n",
  );
});

const WHOLE = `
interface Item { text: string; detail?: string | number }
type Exact = { text: string; detail: string };
function asItem(value: Exact | Item): Item {
  return value;
}
const exact: Exact = { text: "exact", detail: "d" };
const item: Item = { text: "item" };
console.log(asItem(exact).detail, asItem(item).detail);
`;

test("a union the checker still sees whole converts the other arm", async () => {
  const program = await build(WHOLE);
  expect(converting(program.names)).toHaveLength(1);
  expect(program.status).toBe(0);
  expect(program.stdout).toBe("d undefined\n");
});

const UNCHANGED = `
interface Item { text: string; detail?: string | number }
function show(value: Item | undefined): string {
  if (value === undefined) return "none";
  const item: Item = value;
  return item.text;
}
console.log(show({ text: "a" }), show(undefined));
`;

test("a union with nothing beside the arm to convert keeps its extraction", async () => {
  const program = await build(UNCHANGED);
  expect(converting(program.names)).toEqual([]);
  expect(program.status).toBe(0);
  expect(program.stdout).toBe("a none\n");
});
