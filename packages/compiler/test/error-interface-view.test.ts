import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
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

test("an interface that extends Error is the Error class, as the intersection is", async () => {
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
  expect(firstParamType(ir, "viaInterface")).toEqual({ kind: "object", className: "%Error" });
});

test("an interface the Error class cannot answer keeps its record", async () => {
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
  expect(firstParamType(ir, "chained")).toMatchObject({ kind: "record" });
  expect(firstParamType(ir, "carried")).toMatchObject({ kind: "record" });
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

test("only the view of a declared Error subclass is bound to its instance", async () => {
  const errorClass = await build(`
${FAILURE}
function see(v: unknown): void {
  const t = v as { name: string; message: string; stack?: string };
  console.log(t.name, t.message, typeof t.stack);
}
see(new Failure("denied", 403));
`);
  expect(errorClass.ll).toContain("call void @scr_error_class_view(");
  const plainClass = await build(`
class Point {
  x = 1;
  y = 2;
}
function see(v: unknown): void {
  const t = v as { x: number; y: number };
  console.log(t.x + t.y);
}
see(new Point());
`);
  expect(plainClass.ll).not.toContain("scr_error_class_view");
});
