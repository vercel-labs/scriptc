import { expect, test } from "vitest";
import {
  F64,
  REGEX,
  STRING,
  VOID,
  mapOf,
  type IrExpr,
  type IrFunction,
  type IrGlobal,
  type IrModule,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { llvmRefusalDiag } from "../target-diagnostics.js";
import { emitLlvmModule } from "./emitter.js";
import { LlvmUnsupportedError, anchorRefusal } from "./unsupported.js";

const file = "/project/src/refusal.ts";
const at = (start: number, end: number): SrcLoc => ({ file, start, end });
const fnLoc = at(100, 300);
const stmtLoc = at(140, 180);
const exprLoc = at(155, 179);
const table = mapOf(STRING, F64);
const ref = (localId: string, type: IrType): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc: exprLoc,
});

function moduleWith(functions: IrFunction[], globals: IrGlobal[] = []): IrModule {
  return {
    irVersion: 17,
    sourceFile: file,
    entry: "main",
    globals,
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc: at(0, 0) },
      ...functions,
    ],
  };
}

/** `function show(value: Map<string, number>)` (or a value of `type`) with
 * `body` as its statements. */
function show(body: IrStmt[], type: IrType = table): IrFunction {
  return {
    name: "show",
    params: [{ localId: "value", name: "value", type }],
    returnType: STRING,
    locals: [{ id: "value", name: "value", type, mutable: false }],
    body,
    loc: fnLoc,
  };
}

function refusal(mod: IrModule): LlvmUnsupportedError {
  try {
    emitLlvmModule(mod);
  } catch (error) {
    if (error instanceof LlvmUnsupportedError) return error;
    throw error;
  }
  throw new Error("the module was emitted");
}

test("a refusal raised by a type-keyed helper takes the statement's span", () => {
  // The JSON writer is interned per type and knows no IR node. A RegExp is
  // a type it has no writer for (a Map or a Set is written as "{}").
  const error = refusal(
    moduleWith([
      show(
        [
          {
            kind: "return",
            value: {
              kind: "jsonStringify",
              value: ref("value", REGEX),
              type: STRING,
              loc: exprLoc,
            },
            loc: stmtLoc,
          },
        ],
        REGEX,
      ),
    ]),
  );
  expect(error.kind).toBe("jsonStringify:regex");
  expect(error.loc).toEqual(stmtLoc);
  expect(error.functionName).toBe("show");
  const diag = llvmRefusalDiag(error, "/project/src/entry.ts");
  expect(diag.code).toBe("SC3001");
  expect(diag.loc).toEqual(stmtLoc);
  expect(diag.message).toBe(
    "the LLVM backend does not support this construct yet (jsonStringify:regex): " +
      "JSON.stringify reaching a value of type regex, in show",
  );
});

test("a refusal that names its node keeps that node's span", () => {
  const error = refusal(
    moduleWith([
      show([
        {
          kind: "return",
          value: { kind: "toString", operand: ref("value", table), type: STRING, loc: exprLoc },
          loc: stmtLoc,
        },
      ]),
    ]),
  );
  expect(error.kind).toBe("toString:map");
  expect(error.loc).toEqual(exprLoc);
  expect(error.functionName).toBe("show");
});

test("a refused global reports its declaration", () => {
  const declared = at(20, 40);
  const global = (source: boolean): IrGlobal => ({
    id: "%g.m.missing",
    name: "missing",
    type: { kind: "undefinedT" },
    mutable: false,
    ...(source ? { source: { loc: declared, scope: at(0, 400) } } : {}),
  });
  const error = refusal(moduleWith([], [global(true)]));
  expect(error.kind).toBe("global:undefinedT");
  expect(error.loc).toEqual(declared);
  expect(llvmRefusalDiag(error, "/project/src/entry.ts").loc).toEqual(declared);
  // A compiler-made global has no declaration to report.
  expect(refusal(moduleWith([], [global(false)])).loc).toBeUndefined();
});

test("a refusal is never reported at the entry file's first byte", () => {
  const entry = "/project/src/entry.ts";
  const unanchored = llvmRefusalDiag(new LlvmUnsupportedError("rc:void"), entry);
  // No span means the refusal left every statement, function and global:
  // a compiler bug, reported as one.
  expect(unanchored.code).toBe("SC9001");
  expect(unanchored.message).toContain("without a source position");
  expect(unanchored.message).toContain("(rc:void)");
  const anchored = llvmRefusalDiag(new LlvmUnsupportedError("rc:void", stmtLoc), entry);
  expect(anchored).toEqual({
    code: "SC3001",
    message: "the LLVM backend does not support this construct yet (rc:void)",
    loc: stmtLoc,
  });
});

test("the innermost span wins and other errors pass through", () => {
  const error = new LlvmUnsupportedError("type:void", undefined, "type void");
  expect(anchorRefusal(error, stmtLoc)).toBe(error);
  expect(anchorRefusal(error, fnLoc, "outer")).toBe(error);
  expect(error.loc).toEqual(stmtLoc);
  expect(error.describe()).toBe(
    "the LLVM backend does not support this construct yet (type:void): type void, in outer",
  );
  const other = new TypeError("unrelated");
  expect(anchorRefusal(other, stmtLoc, "outer")).toBe(other);
});
