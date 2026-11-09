import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

/** The serialized IR and the LLVM module of one source file. */
async function build(source: string): Promise<{ ir: string; ll: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-error-view-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const lowered = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!lowered.ok)
      throw new Error(lowered.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const ir = await readFile(outPath, "utf8");
    return { ir, ll: emitLlvmModule(deserializeModule(ir)) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The IR type of the first parameter of the function named `name`. */
function firstParamType(ir: string, name: string): unknown {
  const module = JSON.parse(ir) as {
    functions: { name: string; params: { type: unknown }[] }[];
  };
  const fn = module.functions.find((f) => f.name === name || f.name.endsWith(`.${name}`));
  if (!fn)
    throw new Error(`no function ${name} in ${module.functions.map((f) => f.name).join(", ")}`);
  return fn.params[0]?.type;
}

const FAILURE = `
class Failure extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
`;

test("an interface that extends Error is a checked view; the intersection is the Error class", async () => {
  const { ir } = await build(`
interface Like extends Error {
  stack?: string;
  status?: number;
}
function viaInterface(e: Like): string {
  return e.message + "|" + String(e.status) + "|" + typeof e.stack;
}
function viaIntersection(e: Error & { status?: number }): string {
  return e.message + "|" + String(e.status);
}
function see(v: unknown): void {
  console.log(viaInterface(v as Like), viaIntersection(v as Error & { status?: number }));
}
see(new Error("plain"));
`);
  expect(firstParamType(ir, "viaIntersection")).toEqual({ kind: "object", className: "%Error" });
  // The interface has two kinds of values, an error and a plain object with
  // the members: it holds both as the checked-dynamic value.
  expect(firstParamType(ir, "viaInterface")).toEqual({ kind: "dyn" });
});

test("an interface that only names the members of Error keeps its record", async () => {
  const { ir } = await build(`
interface Shaped {
  name: string;
  message: string;
  status?: number;
}
function shaped(e: Shaped): string {
  return e.message;
}
console.log(shaped({ name: "a", message: "b" }));
`);
  expect(firstParamType(ir, "shaped")).toMatchObject({ kind: "record" });
});

test("a self-referential and a generic interface that extend Error are views too", async () => {
  const { ir } = await build(`
interface Chain extends Error {
  next?: Chain;
}
interface Carrier<T> extends Error {
  data?: T;
}
function chained(e: Chain): string {
  return e.message;
}
function carried(e: Carrier<number>): string {
  return e.message;
}
console.log(chained({ name: "a", message: "b" }), carried({ name: "c", message: "d" }));
`);
  expect(firstParamType(ir, "chained")).toEqual({ kind: "dyn" });
  expect(firstParamType(ir, "carried")).toEqual({ kind: "dyn" });
});

test("an error handed to a record type converts through its checked view", async () => {
  const { ir } = await build(`
${FAILURE}
function advice(e: { message?: string; tag?: string }): string {
  return (e.message ?? "none") + "/" + (e.tag ?? "none");
}
function see(v: unknown): void {
  const t = v as Error & { tag?: string };
  console.log(advice(t));
}
see(new Failure("denied", 403));
`);
  expect(firstParamType(ir, "advice")).toMatchObject({ kind: "record" });
  expect(ir).toContain('"kind":"dynCheck"');
});

/** The by-name property helpers of a module, as serialized IR. */
function byNameReads(ir: string): string {
  const module = JSON.parse(ir) as { functions: { name: string }[] };
  return module.functions
    .filter((f) => f.name.startsWith("%dyn.class.property."))
    .map((f) => JSON.stringify(f))
    .join("\n");
}

test("a by-name read of cause on an Error subclass instance asks the native error", async () => {
  const { ir } = await build(`
class Caused extends Error {
  constructor(message: string) {
    super(message, { cause: "root" });
  }
}
function make(): unknown {
  return new Caused("caused");
}
const a: any = make();
console.log(a.cause);
`);
  expect(byNameReads(ir)).toContain('"fn":"error.cause"');
  const plain = await build(`
class Point {
  x = 1;
}
function make(): unknown {
  return new Point();
}
const a: any = make();
console.log(a.cause);
`);
  expect(byNameReads(plain.ir)).not.toContain('"fn":"error.cause"');
});

const GET_STACK = `
class GetStack extends Error {
  get stack(): string {
    return "custom stack";
  }
}
function make(): unknown {
  return new GetStack("gs");
}
const a: any = make();
console.log(a.stack);
`;

test("a stack accessor a class declares answers by name only where the program can delete the own stack", async () => {
  const shadowed = await build(GET_STACK);
  expect(byNameReads(shadowed.ir)).toContain('"fn":"error.stack"');
  const deleted = await build(`${GET_STACK}delete a.stack;\nconsole.log(a.stack);\n`);
  expect(byNameReads(deleted.ir)).not.toContain('"fn":"error.stack"');
});

/** The SC6004 warnings of one source file, as "line: message". */
function classConversionWarnings(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-error-view-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const result = analyze(entry);
    expect(result.coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    return (result.coverage.divergences ?? [])
      .filter((d) => d.code === "SC6004")
      .map((d) => `${source.slice(0, d.loc.start).split("\n").length}: ${d.message}`)
      .sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a value of an interface that extends Error handed to an Error class is warned about by name", () => {
  const warnings = classConversionWarnings(`interface Like extends Error {
  status?: number;
}
function takesError(e: Error): string {
  return e.name + ":" + e.message;
}
function takesLike(e: Like): string {
  return e.name + ":" + e.message;
}
function show(f: Like): Error {
  console.log(takesLike(f));
  console.log(takesError(f));
  const held: Error = f;
  console.log((f as Error).message, held.message);
  return f;
}
show(new Error("real"));
show({ name: "Fake", message: "literal", status: 4 });
`);
  // The argument, the typed binding, the assertion and the returned value.
  expect(warnings.map((w) => w.slice(0, w.indexOf(":")))).toEqual(["12", "13", "14", "15"]);
  expect(warnings[0]).toContain(
    "this 'Like' is converted to the class 'Error': natively the checked conversion throws a TypeError",
  );
  expect(
    classConversionWarnings(`function takesError(e: Error): string {
  return e.name + ":" + e.message;
}
console.log(takesError(new TypeError("typed")));
`),
  ).toEqual([]);
});

test("the conversion to an Error class is warned about at every slot that gives the value its type", () => {
  const warnings = classConversionWarnings(`interface Like extends Error {
  status?: number;
}
interface Holder {
  error: Error;
}
class Keeper {
  error: Error;
  constructor(f: Like) {
    this.error = f;
  }
}
function label(e: Error): string {
  return e.name + ":" + e.message;
}
function run(make: () => Error): string {
  return label(make());
}
const back = (f: Like): Error => f;
function show(f: Like, other: Error): void {
  let held: Error = other;
  held = f;
  const holder: Holder = { error: f };
  holder.error = f;
  const list: Error[] = [f];
  const inner = (e: Error = f): string => label(e);
  const maybe: Error | undefined = f;
  const picked = f.status === undefined ? other : f;
  const args: [Like] = [f];
  const later: Promise<Error> = Promise.resolve(f);
  void later;
  console.log(label(held), label(list[0] ?? other), inner(), run(() => f), label(...args));
  console.log(new Keeper(f).error.message, back(f).message, maybe?.message, picked.message);
}
show(new Error("real"), new Error("other"));
`);
  // A member write in a constructor, an arrow's body, an assignment, a
  // literal's member, a member write, an array element, a default value, a
  // slot that also holds undefined, an arm of a conditional no slot types, a
  // promise's result, a callback's result and a spread tuple. The values
  // handed to a slot of the interface (lines 29 and 33) are not named.
  expect(warnings.map((w) => w.slice(0, w.indexOf(":")))).toEqual([
    "10",
    "19",
    "22",
    "23",
    "24",
    "25",
    "26",
    "27",
    "28",
    "30",
    "32",
    "32",
  ]);
  for (const warning of warnings)
    expect(warning).toContain("this 'Like' is converted to the class 'Error'");
});

test("a generic function called with an Error interface value is warned about where its body converts", () => {
  const warnings = classConversionWarnings(`interface Like extends Error {
  status?: number;
}
function label(e: Error): string {
  return e.name + ":" + e.message;
}
function through<T extends Error>(e: T): string {
  return label(e);
}
function again<U extends Error>(e: U): string {
  return through(e);
}
function show(f: Like): void {
  console.log(through(f), again(f), through(new TypeError("typed")));
}
show(new Error("real"));
`);
  // The one place a value of the type parameter becomes the class: line 8.
  expect(warnings.map((w) => w.slice(0, w.indexOf(":")))).toEqual(["8"]);
  expect(warnings[0]).toContain("this 'Like' is converted to the class 'Error'");
});
