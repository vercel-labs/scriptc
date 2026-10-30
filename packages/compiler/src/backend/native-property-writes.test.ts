import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../ir/ir.js";
import { everyStmtList } from "../ir/traverse.js";
import { validateModule } from "../ir/validate.js";
import { computeNativeSetEffects } from "../ir/native-integrity.js";
import { moduleRuntimeFeatures } from "../ir/runtime-features.js";
import { dynamicFieldStores } from "../ir/int32-slots.js";
import { moduleLibAsyncSurface } from "../library/ir-policy.js";
import { executableLinkFeatures } from "./executable-features.js";
import { computeMayThrow } from "./may-throw.js";
import { guardNativePropertyWrites } from "./native-property-writes.js";

const loc = { file: "native-writes.ts", start: 0, end: 1 };
const type: IrType = { kind: "record", shapeId: "item" };
const receiver: IrExpr = { kind: "varRef", localId: "item", type, loc };
const number: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
const call = (callee: string, type: IrType): IrExpr => ({
  kind: "call",
  callee,
  args: [],
  type,
  loc,
});
function moduleWith(body: IrStmt[], expose = true): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: [
      {
        id: "item",
        fields: [
          { name: "text", type: STRING },
          { name: "value", type: F64 },
        ],
      },
    ],
    functions: [
      {
        name: "main",
        params: [{ localId: "item", name: "item", type }],
        locals: [{ id: "item", name: "item", type, mutable: false }],
        returnType: VOID,
        loc,
        body: [
          ...(expose
            ? [
                {
                  kind: "exprStmt" as const,
                  expr: {
                    kind: "intrinsic" as const,
                    name: "native.isFrozen" as const,
                    args: [receiver],
                    type: BOOL,
                    loc,
                  },
                  loc,
                },
              ]
            : []),
          ...body,
        ],
      },
    ],
  };
}
function writes(mod: IrModule): Extract<IrStmt, { kind: "recordSet" | "recordKeySet" }>[] {
  const found: Extract<IrStmt, { kind: "recordSet" | "recordKeySet" }>[] = [];
  everyStmtList(mod.functions[0]!.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (stmt.kind === "recordSet" || stmt.kind === "recordKeySet") found.push(stmt);
      return true;
    },
  });
  return found;
}

test("keyed native writes finish receiver, key and RHS before one guarded store", () => {
  const source = moduleWith([
    {
      kind: "recordKeySet",
      obj: call("receiver", type),
      shapeId: "item",
      key: call("key", STRING),
      value: call("rhs", F64),
      propertyOp: "setSloppy",
      loc,
    },
  ]);
  const before = JSON.stringify(source);
  const result = guardNativePropertyWrites(source);
  const block = result.functions[0]!.body[1]!;
  expect(block.kind).toBe("block");
  if (block.kind !== "block") throw new Error("missing guard block");
  expect(
    block.body
      .slice(0, 3)
      .map((stmt) =>
        stmt.kind === "varDecl" && stmt.init?.kind === "call" ? stmt.init.callee : null,
      ),
  ).toEqual(["receiver", "key", "rhs"]);
  const guard = block.body[3]!;
  expect(guard.kind).toBe("if");
  if (guard.kind !== "if" || guard.cond.kind !== "intrinsic") throw new Error("missing admission");
  expect(guard.cond.name).toBe("native.checkWrite");
  expect(guard.cond.args[2]).toMatchObject({ kind: "numLit", value: 1 });
  expect(guard.cond.args[3]).toEqual(writes(result)[0]!.value);
  expect(guard.then).toHaveLength(1);
  expect(writes(result)).toHaveLength(1);
  expect(computeMayThrow(result).fns.has("main")).toBe(true);
  expect(JSON.stringify(source)).toBe(before);
  expect(computeNativeSetEffects(result)).toEqual(computeNativeSetEffects(source));
  expect(moduleRuntimeFeatures(result)).toEqual(moduleRuntimeFeatures(source));
});

test("delete keeps metadata finalization inside the successful slot mutation", () => {
  const optional: IrType = { kind: "union", unionId: "optional" };
  const source = moduleWith([
    {
      kind: "recordSet",
      obj: receiver,
      shapeId: "item",
      field: "value",
      value: { kind: "fieldAbsent", unionId: "optional", type: optional, loc },
      propertyOp: "deleteSloppy",
      loc,
    },
  ]);
  source.records![0]!.fields.find((field) => field.name === "value")!.type = optional;
  source.unions = [{ id: "optional", arms: [F64, { kind: "undefinedT" }] }];
  expect(validateModule(source)).toEqual([]);
  const result = guardNativePropertyWrites(source);
  expect(validateModule(result)).toEqual([]);
  const block = result.functions[0]!.body[1]!;
  if (block.kind !== "block") throw new Error("missing guard block");
  const presence = block.body.at(-1)!;
  if (presence.kind !== "if") throw new Error("missing presence check");
  expect(presence.cond.kind).toBe("recordHas");
  const guard = presence.then[0]!;
  if (guard.kind !== "if") throw new Error("missing admission guard");
  expect(
    guard.then.map((stmt) =>
      stmt.kind === "exprStmt" && stmt.expr.kind === "intrinsic" ? stmt.expr.name : stmt.kind,
    ),
  ).toEqual(["recordSet"]);
  expect(writes(result)[0]!.propertyOp).toBe("deleteSloppy");
  expect(guard.else_).toBeNull();
});

test("conditional ABSENT stays at the field-write leaf", () => {
  const optional: IrType = { kind: "union", unionId: "optional" };
  const absent: IrExpr = { kind: "fieldAbsent", unionId: "optional", type: optional, loc };
  const source = moduleWith([
    {
      kind: "recordSet",
      obj: receiver,
      shapeId: "item",
      field: "value",
      value: {
        kind: "ternary",
        cond: { kind: "boolLit", value: true, type: BOOL, loc },
        // oxlint-disable-next-line unicorn/no-thenable -- This is the IR's value arm.
        then: absent,
        else_: {
          kind: "unionWrap",
          unionId: "optional",
          tag: 0,
          value: number,
          type: optional,
          loc,
        },
        type: optional,
        loc,
      },
      loc,
    },
  ]);
  source.records![0]!.fields.find((field) => field.name === "value")!.type = optional;
  source.unions = [{ id: "optional", arms: [F64, { kind: "undefinedT" }] }];
  expect(validateModule(source)).toEqual([]);
  const result = guardNativePropertyWrites(source);
  expect(validateModule(result)).toEqual([]);
  expect(writes(result).filter((stmt) => stmt.value.kind === "fieldAbsent")).toHaveLength(1);
  expect(writes(result).find((stmt) => stmt.value.kind === "fieldAbsent")!.propertyOp).toBe(
    "delete",
  );
  expect(writes(result).find((stmt) => stmt.value.kind !== "fieldAbsent")!.propertyOp).toBe("set");
  expect(computeNativeSetEffects(result)).toEqual(computeNativeSetEffects(source));
});

test("unexposed records keep their original stores", () => {
  const source = moduleWith(
    [{ kind: "recordSet", obj: receiver, shapeId: "item", field: "value", value: number, loc }],
    false,
  );
  expect(guardNativePropertyWrites(source)).toBe(source);
});

test("typed setter effects and async link requirements agree before guard insertion", () => {
  const promise: IrType = { kind: "promise", inner: F64 };
  const callback: IrType = { kind: "func", params: [], ret: promise };
  for (const rhsType of [F64, promise, callback]) {
    for (const operation of ["set", "setSloppy", "define", "deleteSloppy"] as const) {
      for (const expose of [false, true]) {
        const source = moduleWith([], expose);
        source.records![0]!.fields[1]!.type = rhsType;
        if (rhsType === F64) source.records![0]!.fields.unshift({ name: "pending", type: promise });
        const fn = source.functions[0]!;
        fn.params.push({ localId: "rhs", name: "rhs", type: rhsType });
        fn.locals.push({ id: "rhs", name: "rhs", type: rhsType, mutable: false });
        fn.body.push({
          kind: "recordSet",
          obj: receiver,
          shapeId: "item",
          field: "value",
          value: { kind: "varRef", localId: "rhs", type: rhsType, loc },
          propertyOp: operation,
          loc,
        });
        const transformed = guardNativePropertyWrites(source);
        const effects = expose && (operation === "set" || operation === "setSloppy");
        for (const program of [source, transformed]) {
          expect(validateModule(program)).toEqual([]);
          expect(dynamicFieldStores(program).all).toBe(effects);
          expect(moduleRuntimeFeatures(program)).toMatchObject({
            dynAsync: effects,
            dynInvoke: false,
          });
          expect(executableLinkFeatures(program).dynAsync).toBe(effects);
          if (effects) expect(moduleLibAsyncSurface(program)).not.toBeNull();
        }
        expect(computeNativeSetEffects(transformed)).toEqual(computeNativeSetEffects(source));
        source.functions[0]!.body.pop();
        expect(moduleRuntimeFeatures(source).dynAsync).toBe(false);
      }
    }
  }
});

test("ABSENT-only stores and invalid intrinsic arguments cannot become setter values", () => {
  const optional: IrType = { kind: "union", unionId: "optional" };
  const source = moduleWith([
    {
      kind: "recordSet",
      obj: receiver,
      shapeId: "item",
      field: "value",
      value: { kind: "fieldAbsent", unionId: "optional", type: optional, loc },
      loc,
    },
  ]);
  source.records![0]!.fields[1]!.type = optional;
  source.unions = [{ id: "optional", arms: [F64, { kind: "undefinedT" }] }];
  expect(computeNativeSetEffects(source).callsSetter).toBe(false);
  const transformed = guardNativePropertyWrites(source);
  expect(computeNativeSetEffects(transformed).callsSetter).toBe(false);
  expect(validateModule(transformed)).toEqual([]);
  const intrinsic = (args: IrExpr[]): IrStmt => ({
    kind: "exprStmt",
    loc,
    expr: {
      kind: "intrinsic",
      name: "native.checkWrite",
      args,
      type: BOOL,
      loc,
    },
  });
  const key: IrExpr = { kind: "strLit", value: "value", type: STRING, loc };
  const op: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
  expect(validateModule(moduleWith([intrinsic([receiver, key, op])]))).not.toEqual([]);
  expect(validateModule(moduleWith([intrinsic([receiver, key, op, number])]))).toEqual([]);
  expect(
    validateModule(moduleWith([intrinsic([receiver, key, { ...op, value: 2 }, number])])),
  ).not.toEqual([]);
});

test("guarded string append never publishes the frontend's temporary empty slot", () => {
  const old: IrExpr = { kind: "varRef", localId: "old", type: STRING, loc };
  const store = (value: IrExpr): IrStmt => ({
    kind: "recordSet",
    obj: receiver,
    shapeId: "item",
    field: "text",
    value,
    loc,
  });
  const result = guardNativePropertyWrites(
    moduleWith([
      {
        kind: "exprStmt",
        expr: {
          kind: "seqExpr",
          type: STRING,
          loc,
          result: old,
          stmts: [
            store({ kind: "strLit", value: "", type: STRING, loc }),
            {
              kind: "assign",
              localId: "old",
              value: {
                kind: "strConcat",
                left: old,
                right: { kind: "strLit", value: "!", type: STRING, loc },
                type: STRING,
                loc,
              },
              loc,
            },
            store(old),
          ],
        },
        loc,
      },
    ]),
  );
  expect(writes(result)).toHaveLength(1);
});
