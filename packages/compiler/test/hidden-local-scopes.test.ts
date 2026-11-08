import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../src/ir/ir.js";
import { ownEscapingLocals } from "../src/ir/local-scopes.js";
import { everyStmtList } from "../src/ir/traverse.js";

/* A local assigned inside a condition and read by the branches lowers to a
 * declaration in the statement list and an assignment in the condition's
 * sequence. A lowering that saves a value of its own in a condition can
 * produce the other form, the declaration inside the sequence: the backend
 * releases that value when the condition ends. These tests build that form
 * from real lowered programs, and pin that the validator refuses it and that
 * the lowering's ownership rule turns it back into the first form. */

const SOURCE = `
interface Tray {
  label: string;
  cups: number;
}
function fill(i: number): Tray {
  return { label: "tray-" + String(i), cups: i * 2 };
}
function full(t: Tray): boolean {
  return t.cups > 2;
}
function branch(i: number): string {
  let kept: Tray;
  if (((kept = fill(i)), full(kept))) return "full " + kept.label;
  return "light " + kept.label;
}
function loop(i: number): string {
  let seen = "";
  let kept: Tray;
  for (let n = 0; ((kept = fill(i + n)), n < 3 && full(kept)); n++) seen += kept.label;
  return seen + "|" + kept.label;
}
function again(i: number): string {
  let n = 0;
  let kept: Tray;
  while (((kept = fill(i + n)), n++ < 2 && full(kept))) {
    if (kept.cups > 6) break;
  }
  do n++;
  while (((kept = fill(n)), n < 4));
  return kept.label;
}
function chain(i: number): string {
  let kept: Tray;
  if (i !== 3 && ((kept = fill(i)), full(kept))) return "and " + kept.label;
  return "none";
}
function later(i: number): () => string {
  let kept: Tray;
  if (((kept = fill(i)), full(kept))) return () => "late " + kept.label;
  return () => "never";
}
console.log(branch(1), loop(2), again(1), chain(2), later(4)());
`;

async function lowered(): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-hidden-locals-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, SOURCE);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Moves the declaration of each `kept` local into the sequence that
 * assigns it: the hidden-local form. */
function hide(fn: IrFunction, captured: boolean): number {
  const ids = new Set(fn.locals.filter((l) => l.name === "kept").map((l) => l.id));
  let hidden = 0;
  const lists: IrStmt[][] = [fn.body];
  const sequences: (IrExpr & { kind: "seqExpr" })[] = [];
  everyStmtList(fn.body, {
    stmt: (s) => {
      if (s.kind === "block") lists.push(s.body);
      else if (s.kind === "if") lists.push(s.then, ...(s.else_ === null ? [] : [s.else_]));
      else if (s.kind === "while" || s.kind === "doWhile" || s.kind === "for") lists.push(s.body);
      return true;
    },
    expr: (e) => {
      if (e.kind === "seqExpr") sequences.push(e);
      return true;
    },
  });
  const removed = new Set<string>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      if (s.kind !== "varDecl" || !ids.has(s.localId)) continue;
      // A binding a closure captures starts as `undefined`, not empty.
      if (s.init !== null && (s.init.kind !== "unionWrap" || s.init.value.kind !== "unitLit"))
        continue;
      if ((s.init !== null) !== captured) continue;
      list.splice(i--, 1);
      removed.add(s.localId);
    }
  }
  for (const sequence of sequences) {
    for (let i = 0; i < sequence.stmts.length; i++) {
      const s = sequence.stmts[i]!;
      if (s.kind !== "assign" || !removed.has(s.localId)) continue;
      sequence.stmts[i] = { kind: "varDecl", localId: s.localId, init: s.value, loc: s.loc };
      hidden++;
    }
  }
  return hidden;
}

test("the validator refuses a hidden local read after its condition, and the lowering's rule owns it", async () => {
  const mod = await lowered();
  expect(validateModule(mod)).toEqual([]);
  // The rule declares the local at its statement, so only positions differ.
  const shape = (): string =>
    JSON.stringify(mod, (key, value: unknown) => (key === "loc" ? undefined : value));
  const written = shape();

  const ended = (fn: string, region: string): boolean =>
    validateModule(mod).some(
      ({ message }) =>
        message.startsWith("in ") &&
        message.slice(0, message.indexOf(": ")).includes(fn) &&
        message.includes(`local "kept" is used after the ${region} of its declaration ended`),
    );

  let hidden = 0;
  for (const fn of mod.functions) hidden += hide(fn, false);
  // branch, loop, again (its while and its do), chain.
  expect(hidden).toBe(5);
  expect(shape()).not.toBe(written);
  expect(ended("branch", "condition")).toBe(true);
  expect(ended("loop", "condition")).toBe(true);
  expect(ended("again", "condition")).toBe(true);
  expect(ended("chain", "arm")).toBe(true);
  expect(ended("later", "condition")).toBe(false);

  for (const fn of mod.functions) ownEscapingLocals(fn);
  expect(validateModule(mod)).toEqual([]);
  expect(shape()).toBe(written);

  // The binding a closure keeps: the box is the hidden local's.
  hidden = 0;
  for (const fn of mod.functions) hidden += hide(fn, true);
  expect(hidden).toBe(1);
  expect(ended("later", "condition")).toBe(true);
  for (const fn of mod.functions) ownEscapingLocals(fn);
  expect(validateModule(mod)).toEqual([]);
});
