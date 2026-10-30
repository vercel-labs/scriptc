import { describe, expect, test } from "vitest";
import { IR_VERSION } from "./serialize.js";
import { DYN, STRING, VOID, arrayOf, type IrModule, type IrLibFn } from "./ir.js";
import { moduleRuntimeFeatures, moduleUsesHttp2, moduleUsesTlsCa } from "./runtime-features.js";

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
});
