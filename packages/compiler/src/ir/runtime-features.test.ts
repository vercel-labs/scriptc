import { describe, expect, test } from "vitest";
import { IR_VERSION } from "./serialize.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  VOID,
  arrayOf,
  type IrModule,
  type IrLibFn,
  type IrType,
} from "./ir.js";
import { computeNativeSetEffects } from "./native-integrity.js";
import {
  moduleRuntimeFeatures,
  moduleUsesDynAsync,
  moduleUsesHttp2,
  moduleUsesTlsCa,
} from "./runtime-features.js";

describe("runtime feature snapshots", () => {
  const loc = { file: "features.ts", start: 0, end: 0 };
  const module = (): IrModule => ({
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }],
  });
  const call = (fn: IrLibFn) => ({
    kind: "exprStmt" as const,
    loc,
    expr: { kind: "libCall" as const, fn, args: [], type: VOID, loc },
  });

  test("updates link requirements after an IR edit without changing earlier snapshots", () => {
    const mod = module();
    const first = moduleRuntimeFeatures(mod);
    mod.functions[0]!.body.push(call("http2.connect"), call("tlsca.get"));
    expect(moduleRuntimeFeatures(mod)).toMatchObject({
      net: true,
      http: true,
      http2: true,
      tls: true,
      tlsCa: true,
    });
    expect(moduleUsesHttp2(mod)).toBe(true);
    expect(moduleUsesTlsCa(mod)).toBe(true);
    expect(first).toMatchObject({
      net: false,
      http: false,
      http2: false,
      tls: false,
      tlsCa: false,
    });
    mod.functions[0]!.body = [];
    expect(moduleRuntimeFeatures(mod)).toEqual(first);
    expect(moduleUsesHttp2(mod)).toBe(false);
  });

  test("keeps legacy HTTP/2 calls and isolated CA inspection out of the HTTP/2 unit", () => {
    const mod = module();
    mod.functions[0]!.body.push(call("http2.streamNoop"));
    expect(moduleRuntimeFeatures(mod)).toMatchObject({
      net: true,
      http: true,
      http2: false,
      tls: true,
    });
    mod.functions[0]!.body = [call("tlsca.get")];
    expect(moduleRuntimeFeatures(mod)).toMatchObject({
      net: false,
      http: false,
      http2: false,
      tls: false,
      tlsCa: true,
    });
  });

  test.each([
    "dyn.reflectGet",
    "dyn.bagGet",
    "dyn.getPrototype",
    "dyn.hasKey",
    "dyn.hasKeyComputed",
    "dyn.in",
  ] as const)("admits prototype adapters for %s without a method call", (fn) => {
    const mod = module();
    expect(moduleRuntimeFeatures(mod).dynInvoke).toBe(false);
    mod.functions[0]!.body.push(call(fn));
    expect(moduleRuntimeFeatures(mod).dynInvoke).toBe(true);
  });

  test("computed reads and literal presence checks admit prototype adapters", () => {
    const mod = module();
    const value = { kind: "dynArrLit" as const, elems: [], type: DYN, loc };
    mod.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynKeyGet",
        value,
        key: { kind: "strLit", value: "push", type: STRING, loc },
        type: DYN,
        loc,
      },
    });
    expect(moduleRuntimeFeatures(mod).dynInvoke).toBe(true);
    mod.functions[0]!.body[0] = {
      kind: "exprStmt",
      loc,
      expr: { kind: "dynHasKey", value, key: "push", type: { kind: "bool" }, loc },
    };
    expect(moduleRuntimeFeatures(mod).dynInvoke).toBe(true);
    mod.functions[0]!.body = [call("json.parse"), call("dyn.hasOwn")];
    expect(moduleRuntimeFeatures(mod).dynInvoke).toBe(false);
  });

  test("retains runtime units needed only by nested handle storage", () => {
    const mod = module();
    mod.functions[0]!.locals.push({
      id: "handles",
      name: "handles",
      mutable: false,
      type: arrayOf({ kind: "promise", inner: { kind: "secureCtx" } }),
    });
    expect(moduleRuntimeFeatures(mod)).toMatchObject({
      net: true,
      http: true,
      tls: true,
      http2: false,
    });
  });

  test("detects promise boxing independently of static promise storage", () => {
    const mod = module();
    const promise = { kind: "promise" as const, inner: STRING };
    mod.functions[0]!.locals.push({
      id: "promise",
      name: "promise",
      mutable: false,
      type: promise,
    });
    expect(moduleRuntimeFeatures(mod).dynAsync).toBe(false);
    mod.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynFrom",
        type: DYN,
        loc,
        value: { kind: "varRef", localId: "promise", type: promise, loc },
      },
    });
    expect(moduleRuntimeFeatures(mod).dynAsync).toBe(true);
  });

  test("detects promise boxing through record fields and array elements", () => {
    const mod = module();
    const load = {
      kind: "func" as const,
      params: [],
      ret: { kind: "promise" as const, inner: STRING },
    };
    mod.records = [
      { id: "r0", fields: [{ name: "inner", type: { kind: "record", shapeId: "r1" } }] },
      {
        id: "r1",
        fields: [
          { name: "load", type: load },
          { name: "name", type: STRING },
        ],
      },
    ];
    const services = arrayOf({ kind: "record", shapeId: "r0" });
    mod.functions[0]!.locals.push({
      id: "services",
      name: "services",
      mutable: false,
      type: services,
    });
    mod.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynFrom",
        type: DYN,
        loc,
        value: { kind: "varRef", localId: "services", type: services, loc },
      },
    });
    expect(moduleRuntimeFeatures(mod).dynAsync).toBe(true);
    mod.records[1]!.fields[0]!.type = { kind: "func", params: [], ret: STRING };
    expect(moduleRuntimeFeatures(mod).dynAsync).toBe(false);
  });

  test("typed class Set links promise adapters through recursive exact descendants", () => {
    const mod = module();
    const owner: IrType = { kind: "object", className: "Same" };
    const promise: IrType = { kind: "promise", inner: STRING };
    mod.classes = [
      {
        name: "Same",
        fields: [
          { name: "value", type: F64 },
          { name: "cycle", type: { kind: "record", shapeId: "Same" } },
          { name: "privatePromise", type: promise, visibility: "private" },
        ],
        loc,
      },
      { name: "Child", base: "Same", fields: [{ name: "pending", type: promise }], loc },
    ];
    mod.records = [
      { id: "Same", fields: [{ name: "back", type: { kind: "union", unionId: "Same" } }] },
    ];
    mod.unions = [{ id: "Same", arms: [owner, { kind: "undefinedT" }] }];
    const receiver = { kind: "varRef" as const, localId: "owner", type: owner, loc };
    const rhs = { kind: "numLit" as const, value: 3, type: F64, loc };
    const guard = {
      kind: "intrinsic" as const,
      name: "native.checkWrite" as const,
      args: [
        receiver,
        { kind: "strLit" as const, value: "value", type: STRING, loc },
        { kind: "numLit" as const, value: 0, type: F64, loc },
        rhs,
      ],
      type: BOOL,
      loc,
    };
    mod.functions[0]!.locals.push({ id: "owner", name: "owner", type: owner, mutable: false });
    mod.functions[0]!.body.push({ kind: "exprStmt", expr: guard, loc });
    expect(computeNativeSetEffects(mod)).toEqual({ callsSetter: true, boxedTypes: [owner, F64] });
    expect(moduleRuntimeFeatures(mod).dynAsync).toBe(true);
    expect(moduleUsesDynAsync(mod)).toBe(true);
    // Define does not box the receiver/RHS to call an inherited setter.
    guard.args[2] = { kind: "numLit", value: 2, type: F64, loc };
    guard.args.pop();
    expect(computeNativeSetEffects(mod).callsSetter).toBe(false);
    expect(moduleUsesDynAsync(mod)).toBe(false);
    guard.args[2] = { kind: "numLit", value: 1, type: F64, loc };
    guard.args.push(rhs);
    // Same-named record/union/class identities must not hide a public promise.
    mod.classes.pop();
    mod.unions[0]!.arms.push(promise);
    expect(moduleUsesDynAsync(mod)).toBe(true);
    mod.unions[0]!.arms.pop();
    expect(moduleUsesDynAsync(mod)).toBe(false);
  });

  test("detects promise boxing through a function's result type", () => {
    const mod = module();
    const promise = { kind: "promise" as const, inner: STRING };
    mod.unions = [{ id: "u0", arms: [promise, { kind: "undefinedT" }] }];
    const maybe = {
      kind: "func" as const,
      params: [],
      ret: { kind: "union" as const, unionId: "u0" },
    };
    mod.functions[0]!.locals.push({ id: "maybe", name: "maybe", mutable: false, type: maybe });
    mod.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynFrom",
        type: DYN,
        loc,
        value: { kind: "varRef", localId: "maybe", type: maybe, loc },
      },
    });
    expect(moduleRuntimeFeatures(mod).dynAsync).toBe(true);
    mod.unions[0]!.arms[0] = STRING;
    expect(moduleRuntimeFeatures(mod).dynAsync).toBe(false);
  });
});
