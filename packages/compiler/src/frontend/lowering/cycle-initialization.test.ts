import { expect, test } from "vitest";
import type { Program, SourceFile } from "../ts7/adapter.js";
import { F64, type IrFunction, type IrGlobal, type IrModule, type IrStmt } from "../../ir/ir.js";
import { checkCycleBindingAccesses } from "./cycle-initialization.js";
import { Lowerer } from "./lowerer.js";

const loc = { file: "cycle.ts", start: 0, end: 1 };

const lowerer = (): Lowerer =>
  new Lowerer(
    { getTypeChecker: () => ({}), isSourceFileDefaultLibrary: () => false } as unknown as Program,
    { fileName: "/island/entry.ts" } as SourceFile,
    [],
  );

/** A function whose body reads the flagged global `global.0`. */
const reader = (name: string): IrFunction => ({
  name,
  params: [],
  returnType: F64,
  locals: [],
  body: [
    {
      kind: "return",
      value: { kind: "varRef", localId: "global.0", type: F64, loc },
      loc,
    },
  ],
  loc,
});

/** A function whose body names nothing flagged. */
const unrelated = (name: string): IrFunction => ({
  name,
  params: [],
  returnType: F64,
  locals: [],
  body: [{ kind: "return", value: { kind: "numLit", value: 1, type: F64, loc }, loc }],
  loc,
});

test("a function that names no flagged binding keeps its nodes", () => {
  const subject = lowerer();
  const module = {} as SourceFile;
  subject.cycleInitFlags.set("global.0", {
    global: {} as IrGlobal,
    flagId: "%cycleFlag.0",
    name: "value",
    module,
    settled: new Set(),
    cycle: true,
  });
  const reading = reader("%reading");
  const other = unrelated("%other");
  const mod = { functions: [reading, other] } as unknown as IrModule;
  const otherNode = other.body[0] as IrStmt;
  checkCycleBindingAccesses(subject, mod);
  // The unit that reads the binding is rewritten; the one that does not
  // keeps its own nodes, which a rebuild would have replaced with equal ones.
  const returned = (reading.body[0] as IrStmt & { value: { kind: string } }).value;
  expect(returned.kind).toBe("seqExpr");
  expect(other.body[0]).toBe(otherNode);
});
