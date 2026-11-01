import { describe, expect, test } from "vitest";
import { IR_VERSION } from "./serialize.js";
import { DYN, STRING, VOID, arrayOf, type IrModule, type IrLibFn } from "./ir.js";
import {
  JS_OBJECT_MODEL_LIB_FNS,
  moduleRuntimeFeatures,
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

  test("links the inspect unit for a BigInt rendered in Node's form", () => {
    const mod = module();
    mod.functions[0]!.body.push(call("bigint.inspect"));
    expect(moduleRuntimeFeatures(mod)).toMatchObject({ bigint: true, inspect: true });
  });

  test("gates the BigIntStats unit on its member reads, not on bigint", () => {
    const reads = module();
    reads.functions[0]!.body.push(call("bigstats.size"));
    expect(moduleRuntimeFeatures(reads)).toMatchObject({ bigint: true, bigstats: true });

    const storage = module();
    storage.functions[0]!.locals.push({
      id: "value",
      name: "value",
      mutable: false,
      type: { kind: "bigint" },
    });
    expect(moduleRuntimeFeatures(storage)).toMatchObject({ bigint: true, bigstats: false });
  });

  test("gates the call-time parameter bind unit on a barriered generator", () => {
    const mod = module();
    const generator = (bindAtCall: boolean): IrModule["functions"][number] => ({
      name: bindAtCall ? "pick" : "plain",
      params: [],
      locals: [],
      returnType: VOID,
      body: [],
      loc,
      generator: {
        yieldT: STRING,
        nextT: VOID,
        resultType: { kind: "record", shapeId: "gen-result" },
        ...(bindAtCall ? { bindAtCall: true as const } : {}),
      },
    });
    mod.functions.push(generator(false));
    expect(moduleRuntimeFeatures(mod).genBind).toBe(false);
    mod.functions.push(generator(true));
    expect(moduleRuntimeFeatures(mod).genBind).toBe(true);
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

  test("the any-object descriptor entry points link the dyn-invoke unit", () => {
    for (const fn of [
      "dyn.definePropertyShapes",
      "dyn.definePropsShapes",
      "dyn.objCreateWithPropertiesShapes",
    ] as const) {
      const mod = module();
      mod.functions[0]!.body.push(call(fn));
      expect(moduleRuntimeFeatures(mod).dynInvoke).toBe(true);
    }
  });

  test("the generic Promise statics link the units their algorithms call", () => {
    // The implementing unit calls C's resolve and the iterable's next/return
    // through scr_dyn_invoke and builds and settles capability promises with
    // scr_async_dyn: a program that makes only this call still links both, or
    // the source build fails to link.
    const mod = module();
    mod.functions[0]!.body.push(call("promise.genericStatic"));
    expect(moduleRuntimeFeatures(mod)).toMatchObject({
      promiseGeneric: true,
      dynInvoke: true,
      dynAsync: true,
    });
  });

  test("constant-key reads of inherited method names link the dyn-invoke unit", () => {
    const reads = (key: string): IrModule => {
      const mod = module();
      mod.functions[0]!.body.push({
        kind: "exprStmt",
        loc,
        expr: {
          kind: "dynKeyGet",
          value: { kind: "varRef", localId: "value", type: DYN, loc },
          key: { kind: "strLit", value: key, type: STRING, loc },
          type: DYN,
          loc,
        },
      });
      return mod;
    };
    for (const key of ["toString", "slice", "map", "findLastIndex"])
      expect(moduleRuntimeFeatures(reads(key)).dynInvoke, key).toBe(true);
    for (const key of ["length", "name", "nope"])
      expect(moduleRuntimeFeatures(reads(key)).dynInvoke, key).toBe(false);
  });

  test("the JavaScript object model build owns the intrinsic reads and buffer views registry calls", () => {
    // t262-da §J: the features only a JavaScript source reaches share one
    // runtime feature, whose entry list the slices fill as they land. A1
    // contributes the intrinsic object reads; the buffer views registry
    // (t262-dc C2) arms itself through these calls, and the resizable
    // constructors lower to them. A program with a sibling dynamic feature
    // keeps the default objects.
    expect([...JS_OBJECT_MODEL_LIB_FNS].sort()).toEqual([
      "arrayBuffer.armMutable",
      "arrayBuffer.newResizable",
      "dyn.intrinsic",
      "sharedArrayBuffer.newGrowable",
    ]);
    const mod = module();
    mod.functions[0]!.body.push(call("dyn.stdlibPrototype"));
    const features = moduleRuntimeFeatures(mod);
    expect(features.stdlibPrototypeValue).toBe(true);
    expect(features.jsObjectModel).toBe(false);
    expect(features.mutableBuffers).toBe(false);
    for (const fn of JS_OBJECT_MODEL_LIB_FNS) {
      const armed = module();
      armed.functions[0]!.body.push(call(fn));
      expect(moduleRuntimeFeatures(armed).jsObjectModel, fn).toBe(true);
    }
    const bufferFns = [
      "arrayBuffer.newResizable",
      "sharedArrayBuffer.newGrowable",
      "arrayBuffer.armMutable",
    ] as const;
    for (const fn of bufferFns) {
      const armed = module();
      armed.functions[0]!.body.push(call(fn));
      expect(moduleRuntimeFeatures(armed).mutableBuffers, fn).toBe(true);
    }
    const intrinsic = module();
    intrinsic.functions[0]!.body.push(call("dyn.intrinsic"));
    // The pack selection ORs dynTier in (jsObjectModelFact), so the module
    // scan only has to name the object-model build.
    expect(moduleRuntimeFeatures(intrinsic)).toMatchObject({ jsObjectModel: true });
    expect(moduleRuntimeFeatures(intrinsic).mutableBuffers).toBe(false);
  });

  test("gates the BigInt typed-array element kinds on the constructor name", () => {
    // The two BigInt kinds have no double-backed element, so their code lives
    // in the JavaScript object model build (t262-da §J); every other typed
    // array keeps the default one.
    const bytesCall = (name: string) => ({
      kind: "exprStmt" as const,
      loc,
      expr: {
        kind: "libCall" as const,
        fn: "bytes.constructor" as IrLibFn,
        args: [{ kind: "strLit" as const, value: name, type: STRING, loc }],
        type: DYN,
        loc,
      },
    });
    for (const name of ["BigInt64Array", "BigUint64Array"]) {
      const mod = module();
      expect(moduleRuntimeFeatures(mod).bigintBytes).toBe(false);
      mod.functions[0]!.body.push(bytesCall(name));
      expect(moduleRuntimeFeatures(mod).bigintBytes).toBe(true);
    }
    const numeric = module();
    numeric.functions[0]!.body.push(bytesCall("Uint8Array"));
    expect(moduleRuntimeFeatures(numeric).bigintBytes).toBe(false);
  });
});
