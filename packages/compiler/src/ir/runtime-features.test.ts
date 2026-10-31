import { describe, expect, test } from "vitest";
import { IR_VERSION } from "./serialize.js";
import { BOOL, DYN, STRING, VOID, arrayOf, type IrModule, type IrLibFn } from "./ir.js";
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

  test("gates the fs read's Buffer brand on a typed read plus an observable brand", () => {
    const bytes = { kind: "bytes" as const, elem: "u8" as const };
    const data = { kind: "varRef" as const, localId: "data", type: bytes, loc };
    const withRead = (): IrModule => {
      const mod = module();
      mod.functions[0]!.locals.push({ id: "data", name: "data", mutable: false, type: bytes });
      mod.functions[0]!.body.push({
        kind: "exprStmt",
        loc,
        expr: { kind: "libCall", fn: "fs.readFileSyncBytes", args: [], type: bytes, loc },
      });
      return mod;
    };
    // A read alone keeps the default scr_lib.c object.
    expect(moduleRuntimeFeatures(withRead()).fsBufferBrand).toBe(false);
    // Buffer.isBuffer on bytes reads the brand.
    const branded = withRead();
    branded.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: { kind: "libCall", fn: "buffer.isBranded", args: [data], type: BOOL, loc },
    });
    expect(moduleRuntimeFeatures(branded).fsBufferBrand).toBe(true);
    // inspect of a Uint8Array-typed bytes value renders the Buffer form.
    const inspected = withRead();
    inspected.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: { kind: "libCall", fn: "insp.bytes", args: [data], type: STRING, loc },
    });
    expect(moduleRuntimeFeatures(inspected).fsBufferBrand).toBe(true);
    // Boxing to dyn (unknown, .constructor, instanceof) carries the brand.
    const boxed = withRead();
    boxed.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: { kind: "dynFrom", type: DYN, loc, value: data },
    });
    expect(moduleRuntimeFeatures(boxed).fsBufferBrand).toBe(true);
    // A function returning bytes boxed into dyn: its call thunk boxes the
    // result.
    const reader = { kind: "func" as const, params: [], ret: bytes };
    const boxedReader = withRead();
    boxedReader.functions[0]!.locals.push({
      id: "reader",
      name: "reader",
      mutable: false,
      type: reader,
    });
    boxedReader.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynFrom",
        type: DYN,
        loc,
        value: { kind: "varRef", localId: "reader", type: reader, loc },
      },
    });
    expect(moduleRuntimeFeatures(boxedReader).fsBufferBrand).toBe(true);
    // A checked-dynamic function typed to take bytes: its thunk boxes the
    // argument.
    const consumer = { kind: "func" as const, params: [bytes], ret: VOID };
    const checkedConsumer = withRead();
    checkedConsumer.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynCheck",
        type: consumer,
        loc,
        value: { kind: "varRef", localId: "callback", type: DYN, loc },
      },
    });
    expect(moduleRuntimeFeatures(checkedConsumer).fsBufferBrand).toBe(true);
  });

  test("gates the Buffer brand off without a typed read", () => {
    const bytes = { kind: "bytes" as const, elem: "u8" as const };
    // A dynamic read brands through scr_dyn_new_buffer already.
    const dynamic = module();
    dynamic.functions[0]!.body.push(call("fs.readFileSyncDyn"));
    dynamic.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynTest",
        test: "buffer",
        value: { kind: "varRef", localId: "data", type: DYN, loc },
        type: BOOL,
        loc,
      },
    });
    expect(moduleRuntimeFeatures(dynamic).fsBufferBrand).toBe(false);
    // Observing bytes that no typed read produced selects nothing.
    const observationOnly = module();
    observationOnly.functions[0]!.locals.push({
      id: "data",
      name: "data",
      mutable: false,
      type: bytes,
    });
    observationOnly.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: { kind: "libCall", fn: "buffer.isBranded", args: [], type: BOOL, loc },
    });
    expect(moduleRuntimeFeatures(observationOnly).fsBufferBrand).toBe(false);
  });

  test("reaches bytes through nested and recursive declarations", () => {
    const bytes = { kind: "bytes" as const, elem: "u8" as const };
    const boxedShape = (records: NonNullable<IrModule["records"]>, shapeId: string): IrModule => {
      const mod = module();
      mod.functions[0]!.body.push({
        kind: "exprStmt",
        loc,
        expr: { kind: "libCall", fn: "fs.readFileSyncBytes", args: [], type: bytes, loc },
      });
      mod.records = records;
      const shape = { kind: "record" as const, shapeId };
      mod.functions[0]!.locals.push({ id: "shape", name: "shape", mutable: false, type: shape });
      mod.functions[0]!.body.push({
        kind: "exprStmt",
        loc,
        expr: {
          kind: "dynFrom",
          type: DYN,
          loc,
          value: { kind: "varRef", localId: "shape", type: shape, loc },
        },
      });
      return mod;
    };
    // A record holding a record that holds bytes.
    const nested = boxedShape(
      [
        { id: "r0", fields: [{ name: "inner", type: { kind: "record", shapeId: "r1" } }] },
        { id: "r1", fields: [{ name: "data", type: bytes }] },
      ],
      "r0",
    );
    expect(moduleRuntimeFeatures(nested).fsBufferBrand).toBe(true);
    // A record that refers to itself and holds bytes.
    const recursive = boxedShape(
      [
        {
          id: "r0",
          fields: [
            { name: "next", type: { kind: "record", shapeId: "r0" } },
            { name: "data", type: bytes },
          ],
        },
      ],
      "r0",
    );
    expect(moduleRuntimeFeatures(recursive).fsBufferBrand).toBe(true);
    // A record cycle that never reaches bytes.
    const empty = boxedShape(
      [{ id: "r0", fields: [{ name: "next", type: { kind: "record", shapeId: "r0" } }] }],
      "r0",
    );
    expect(moduleRuntimeFeatures(empty).fsBufferBrand).toBe(false);
  });

  test("the JavaScript object model build owns no entry yet", () => {
    // t262-da §J: the features only a JavaScript source reaches share one
    // runtime feature, whose entry list the slices fill as they land. This
    // branch lists none, so a program with a sibling dynamic feature keeps
    // the default objects.
    expect(JS_OBJECT_MODEL_LIB_FNS.size).toBe(0);
    const mod = module();
    mod.functions[0]!.body.push(call("dyn.stdlibPrototype"));
    const features = moduleRuntimeFeatures(mod);
    expect(features.stdlibPrototypeValue).toBe(true);
    expect(features.jsObjectModel).toBe(false);
  });
});
