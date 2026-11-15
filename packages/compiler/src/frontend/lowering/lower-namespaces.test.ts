/* A member of a module namespace reads the exporter's binding. When the
 * receiver is more than a reference (`(await import("./m")).f`), the
 * receiver is evaluated first: the import runs the module's body. */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrExpr, IrFunction, IrModule } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function lower(files: Record<string, string>): Promise<IrModule> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "scriptc-namespaces-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  const outPath = join(dir, "main.ir.json");
  const result = await compile(join(dir, "main.ts"), { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return deserializeModule(await readFile(outPath, "utf8"));
}

function expressions(fn: IrFunction): IrExpr[] {
  const found: IrExpr[] = [];
  everyStmtList(fn.body, {
    stmt: () => true,
    expr: (e) => {
      found.push(e);
      return true;
    },
  });
  return found;
}

/** The functions the program's source declares under `name`. */
function fnNamed(mod: IrModule, name: string): IrFunction {
  const fn = mod.functions.find((f) => f.name === name || f.sourceName === name);
  if (fn === undefined) throw new Error(`no function ${name}`);
  return fn;
}

/** Whether an expression holds a value that is a module's namespace: the
 * result of a dynamic import, which evaluates the module. */
function runsAnInitializer(e: IrExpr): boolean {
  return JSON.stringify(e).includes('"kind":"moduleNs"');
}

const COMMAND = `const label = ["command"];
export default async (name: string): Promise<number> => {
  console.log(label.join(""), name);
  return 2;
};
export function describe(what: string): string {
  return label.join("") + what;
}
`;

test("a member read off a dynamic import evaluates the import first", async () => {
  const mod = await lower({
    "main.ts": `async function pick(): Promise<unknown> {
  return (await import("./command.ts")).default;
}
pick().then((f) => console.log(typeof f));
`,
    "command.ts": COMMAND,
  });
  const read = expressions(fnNamed(mod, "pick")).filter(
    (e) => e.kind === "varRef" && e.localId.endsWith(".default"),
  );
  expect(read).toHaveLength(1);
  // The read is the result of a sequence whose statements run the import.
  const sequences = expressions(fnNamed(mod, "pick")).filter(
    (e) => e.kind === "seqExpr" && e.result === read[0],
  );
  expect(sequences).toHaveLength(1);
  expect(runsAnInitializer(sequences[0]!)).toBe(true);
});

test("a member called off a dynamic import evaluates the import first", async () => {
  const mod = await lower({
    "main.ts": `async function tell(): Promise<string> {
  return (await import("./command.ts")).describe("!");
}
tell().then((s) => console.log(s));
`,
    "command.ts": COMMAND,
  });
  expect(expressions(fnNamed(mod, "tell")).some(runsAnInitializer)).toBe(true);
});

test("a member called off a dynamic import is the member's own call, after the import", async () => {
  const mod = await lower({
    "main.ts": `async function tell(): Promise<string> {
  return (await import("./command.ts")).describe("!");
}
tell().then((s) => console.log(s));
`,
    "command.ts": COMMAND,
  });
  // The direct call of the declaration, as through a namespace binding,
  // as the result of a sequence whose statements run the import.
  const sequences = expressions(fnNamed(mod, "tell")).filter(
    (e) => e.kind === "seqExpr" && e.result.kind === "call",
  );
  expect(sequences).toHaveLength(1);
  expect(runsAnInitializer(sequences[0]!)).toBe(true);
});

test("an export that reads this stays refused when called off a dynamic import", async () => {
  // Node passes the module object as `this`; the call has no value for it,
  // through a namespace binding and through a dynamic import alike.
  const files = (call: string): Record<string, string> => ({
    "main.ts": `${call}\n`,
    "who.ts": `export function who(this: unknown): string {
  return this === undefined ? "no receiver" : typeof this;
}
`,
  });
  await expect(
    lower(
      files(`async function ask(): Promise<string> {
  return (await import("./who.ts")).who();
}
ask().then((s) => console.log(s));`),
    ),
  ).rejects.toThrow(/SC1090: calling a module export that reads 'this'/);
  await expect(
    lower(files(`import * as ns from "./who.ts";\nconsole.log(ns.who());`)),
  ).rejects.toThrow(/SC1090: calling a module export that reads 'this'/);
  // Detached from the import, the function is called without a receiver,
  // as in Node: nothing to refuse.
  const mod = await lower(
    files(`async function ask(): Promise<string> {
  const who = (await import("./who.ts")).who;
  return who();
}
ask().then((s) => console.log(s));`),
  );
  expect(expressions(fnNamed(mod, "ask")).some(runsAnInitializer)).toBe(true);
});

test("a member read through a namespace binding stays a plain read", async () => {
  const mod = await lower({
    "main.ts": `import * as command from "./command.ts";
function tell(): string {
  return command.describe("!");
}
console.log(tell(), typeof command.default);
`,
    "command.ts": COMMAND,
  });
  const inTell = expressions(fnNamed(mod, "tell"));
  expect(inTell.some((e) => e.kind === "seqExpr")).toBe(false);
  expect(inTell.some(runsAnInitializer)).toBe(false);
});
