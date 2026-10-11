import { expect, test } from "vitest";
import { analyzeFinalFields, constructorClass } from "./final-fields.js";
import {
  BOOL,
  STRING,
  VOID,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "./ir.js";

const loc = { file: "final-fields.ts", start: 0, end: 0 };
const obj = (className: string): IrType => ({ kind: "object", className });
const ref = (localId: string, type: IrType): IrExpr => ({ loc, kind: "varRef", localId, type });
const str = (value: string): IrExpr => ({ loc, kind: "strLit", value, type: STRING });
const set = (target: IrExpr, className: string, field: string, value: IrExpr): IrStmt => ({
  loc,
  kind: "fieldSet",
  obj: target,
  className,
  field,
  value,
});
const fn = (name: string, self: string | null, body: IrStmt[]): IrFunction => ({
  loc,
  name,
  params: self ? [{ localId: "this", name: "this", type: obj(self) }] : [],
  locals: self ? [{ id: "this", name: "this", type: obj(self), mutable: false }] : [],
  returnType: VOID,
  body,
});
const cls = (name: string, fields: string[], base?: string): IrClassDef => ({
  loc,
  name,
  ...(base ? { base } : {}),
  fields: fields.map((field) => ({ name: field, type: STRING })),
});
const mod = (classes: IrClassDef[], functions: IrFunction[]): IrModule => ({
  irVersion: 15,
  sourceFile: "final-fields.ts",
  entry: "%main",
  classes,
  functions: [fn("%main", null, []), ...functions],
  records: [],
  unions: [],
  globals: [],
});
const self = (className: string): IrExpr => ref("this", obj(className));

test("constructor names map to their class", () => {
  expect(constructorClass("%%m1.Parser.constructor")).toBe("%m1.Parser");
  expect(constructorClass("%%m1.Parser.parse")).toBeNull();
});

test("fields written only through their constructors' this are final", () => {
  const finals = analyzeFinalFields(
    mod(
      [cls("A", ["kept", "moved"]), cls("B", ["kept", "moved", "own"], "A")],
      [
        fn("%A.constructor", "A", [
          set(self("A"), "A", "kept", str("a")),
          set(self("A"), "A", "kept", str("twice")),
          set(self("A"), "A", "moved", str("a")),
        ]),
        // A subclass constructor initializes its base's field through a guard.
        fn("%B.constructor", "B", [
          set(
            {
              loc,
              kind: "seqExpr",
              stmts: [
                {
                  loc,
                  kind: "if",
                  cond: {
                    loc,
                    kind: "unary",
                    op: "!",
                    operand: ref("superCalled", BOOL),
                    type: BOOL,
                  },
                  then: [
                    {
                      loc,
                      kind: "exprStmt",
                      expr: {
                        loc,
                        kind: "libCall",
                        fn: "error.nodeThrow",
                        args: [str("ReferenceError")],
                        type: VOID,
                      },
                    },
                  ],
                  else_: null,
                },
              ],
              result: self("B"),
              type: obj("B"),
            },
            "B",
            "own",
            str("b"),
          ),
        ]),
        // Any write elsewhere disqualifies the field family.
        fn("%A.reset", "A", [set(self("A"), "A", "moved", str("later"))]),
      ],
    ),
  );
  expect(finals.isFinal("A", "kept")).toBe(true);
  expect(finals.isFinal("B", "kept")).toBe(true);
  expect(finals.isFinal("B", "own")).toBe(true);
  expect(finals.isFinal("A", "moved")).toBe(false);
  expect(finals.isFinal("B", "moved")).toBe(false);
  expect(finals.reasons.get("A\0moved")).toBe("written in %A.reset");
});

test("constructors writing another object, and library builds, are not final", () => {
  const other = fn("%A.constructor", "A", [set(ref("peer", obj("A")), "A", "kept", str("a"))]);
  other.locals.push({ id: "peer", name: "peer", type: obj("A"), mutable: false });
  expect(analyzeFinalFields(mod([cls("A", ["kept"])], [other])).isFinal("A", "kept")).toBe(false);
  const library = mod([cls("A", ["kept"])], []);
  library.lib = { profile: "p" } as unknown as NonNullable<IrModule["lib"]>;
  expect(analyzeFinalFields(library).size).toBe(0);
});
