import { expect, test } from "vitest";
import type { Program, SourceFile } from "../ts7/adapter.js";
import {
  F64,
  type IrExpr,
  type IrFunction,
  type IrGlobal,
  type IrModule,
  type IrStmt,
} from "../../ir/ir.js";
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

/** A flagged class whose static members are reached through `owners`. */
const classFlag = (
  className: string,
  owners: readonly string[],
  reference: { file: string; start: number; end: number; name: string },
) => ({
  global: {} as IrGlobal,
  flagId: `%g.class.${className}%initialized`,
  name: className,
  module: {} as SourceFile,
  settled: new Set<SourceFile>(),
  cycle: true,
  className,
  staticOwners: owners,
  references: [
    {
      loc: { file: reference.file, start: reference.start, end: reference.end },
      name: reference.name,
    },
  ],
});

test("an inherited static call is checked against the class its reference names", () => {
  const subject = lowerer();
  const aLoc = { file: "cycle.ts", start: 10, end: 12 };
  const bLoc = { file: "cycle.ts", start: 20, end: 22 };
  subject.classInitFlags.set("A", classFlag("A", ["Base", "A"], { ...aLoc, name: "A" }));
  subject.classInitFlags.set("B", classFlag("B", ["Base", "B"], { ...bLoc, name: "B" }));
  const call: IrExpr = {
    kind: "call",
    callee: "%Base.static:value",
    args: [],
    type: F64,
    loc: aLoc,
  };
  const fn: IrFunction = {
    name: "%main",
    params: [],
    returnType: F64,
    locals: [],
    body: [{ kind: "exprStmt", expr: call, loc: aLoc }],
    loc: aLoc,
  };
  checkCycleBindingAccesses(subject, { functions: [fn] } as unknown as IrModule);
  // Both A and B list `Base` as a static owner; the call is the source
  // reference to A, so A's flag must be the one checked.
  const rewritten = (fn.body[0] as IrStmt & { expr: IrExpr }).expr;
  expect(rewritten.kind).toBe("seqExpr");
  const tdzCheck = (rewritten as Extract<IrExpr, { kind: "seqExpr" }>).stmts[0] as IrStmt & {
    expr: Extract<IrExpr, { kind: "intrinsic" }>;
  };
  expect(tdzCheck.expr.args[0]).toMatchObject({
    kind: "varRef",
    localId: "%g.class.A%initialized",
  });
});
