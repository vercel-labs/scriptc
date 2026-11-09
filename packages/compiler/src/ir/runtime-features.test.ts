import { describe, expect, test } from "vitest";
import { IR_VERSION } from "./serialize.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  arrayOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrLibFn,
  type IrType,
  type IrStmt,
} from "./ir.js";
import {
  JS_OBJECT_MODEL_LIB_FNS,
  jsObjectModelFact,
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

  test("selects the fetch unit's Blob/File body build only for programs that build one", () => {
    const plain = module();
    plain.functions[0]!.body.push(call("fetch.input"));
    expect(moduleRuntimeFeatures(plain)).toMatchObject({ fetch: true, webBodies: false });

    const blob = module();
    blob.functions[0]!.body.push(call("blob.new"), call("fetch.input"));
    expect(moduleRuntimeFeatures(blob)).toMatchObject({ fetch: true, webBodies: true });
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

  test("gates the kept-source read unit on the record width copy's libCall", () => {
    const mod = module();
    expect(moduleRuntimeFeatures(mod).recordSourceGet).toBe(false);
    mod.functions[0]!.body.push(call("record.sourceGet"));
    expect(moduleRuntimeFeatures(mod).recordSourceGet).toBe(true);
    // The per-key presence test lives in the same unit.
    const probe = module();
    probe.functions[0]!.body.push(call("record.sourceHasKey"));
    expect(moduleRuntimeFeatures(probe).recordSourceGet).toBe(true);
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

  test("the JavaScript object model build owns the buffer views registry calls", () => {
    // t262-da §J: the features only a JavaScript source reaches share one
    // runtime feature, whose entry list the slices fill as they land. The
    // buffer views registry (t262-dc C2) arms itself through these calls, and
    // the resizable constructors lower to them, so a program that makes one
    // selects the object model build; every other program keeps the default
    // objects.
    expect([...JS_OBJECT_MODEL_LIB_FNS].sort()).toEqual([
      "arrayBuffer.armMutable",
      "arrayBuffer.newResizable",
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
      expect(moduleRuntimeFeatures(armed).mutableBuffers, fn).toBe(true);
    }
  });

  test("a process stream held as a value is the stdioObject feature", () => {
    // The stream object is the only way to replace process.stdout.write, so
    // the two lib calls that answer it, and a value of the stream's type
    // (boxing one creates the object), decide whether a program's islands
    // share its write slot (scr_node_island_stdio.c). Console output and
    // direct writes never create the object.
    for (const fn of ["process.stdio", "process.stdioSlot"] as const) {
      const mod = module();
      mod.functions[0]!.body.push(call(fn));
      expect(moduleRuntimeFeatures(mod).stdioObject, fn).toBe(true);
    }
    const typed = module();
    typed.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "libCall",
        fn: "process.stdoutWrite",
        args: [],
        type: { kind: "procStream" },
        loc,
      },
    });
    expect(moduleRuntimeFeatures(typed).stdioObject).toBe(true);
    for (const fn of ["process.stdoutWrite", "process.stdioWriteStr"] as const) {
      const mod = module();
      mod.functions[0]!.body.push(call(fn));
      expect(moduleRuntimeFeatures(mod).stdioObject, fn).toBe(false);
    }
  });

  test("a dynamic __proto__ key selects the object model build", () => {
    // Object.prototype's __proto__ accessor is modelled in the object model
    // build of scr_json.c, so a source that reads or writes the member by
    // name under a dynamic key takes that build; every other program keeps
    // the default object, byte for byte.
    const obj = (): IrExpr => ({ kind: "varRef", localId: "o", type: DYN, loc });
    const key = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
    const read = module();
    read.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: { kind: "dynKeyGet", value: obj(), key: key("__proto__"), type: DYN, loc },
    });
    const readFeatures = moduleRuntimeFeatures(read);
    expect(readFeatures.protoAccessor).toBe(true);
    expect(jsObjectModelFact(readFeatures)).toBe(true);
    for (const fn of ["dyn.keySet", "dyn.bagGet", "dyn.bagSet"] as const) {
      const write = module();
      write.functions[0]!.body.push({
        kind: "exprStmt",
        loc,
        expr: { kind: "libCall", fn, args: [obj(), key("__proto__"), obj()], type: VOID, loc },
      });
      const writeFeatures = moduleRuntimeFeatures(write);
      expect(writeFeatures.protoAccessor, fn).toBe(true);
      expect(jsObjectModelFact(writeFeatures), fn).toBe(true);
    }
    // A literal member named `__proto__` is a property definition, which the
    // backend emits through the object model build's define entry.
    const literal = module();
    literal.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynObjLit",
        fields: [{ key: key("__proto__"), value: obj() }],
        type: DYN,
        loc,
      },
    });
    const literalFeatures = moduleRuntimeFeatures(literal);
    expect(literalFeatures.protoAccessor).toBe(true);
    expect(jsObjectModelFact(literalFeatures)).toBe(true);
    const ordinary = module();
    ordinary.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: { kind: "dynKeyGet", value: obj(), key: key("constructor"), type: DYN, loc },
    });
    ordinary.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynObjLit",
        fields: [{ key: key("x"), value: obj() }],
        type: DYN,
        loc,
      },
    });
    const ordinaryFeatures = moduleRuntimeFeatures(ordinary);
    expect(ordinaryFeatures.protoAccessor).toBe(false);
    expect(jsObjectModelFact(ordinaryFeatures)).toBe(false);
  });

  test("selects the JavaScript object model build for writes that spell a sparse index", () => {
    // t262 W7: only a write the source spells an index past the dense
    // prefix's materialization limit (1000000 elements, scr_json.c) selects
    // the build, and a keyed write evaluates its key into a hidden local
    // first, so the literal reaches the write through that local's
    // definition. A key computed at run time cannot be proven sparse and
    // keeps its SC2020 refusal: selecting the build for it would rebuild
    // every program with a computed write.
    const boxed = (value: IrExpr): IrExpr => ({ kind: "dynFrom", value, type: DYN, loc });
    const num = (value: number): IrExpr => ({ kind: "numLit", value, type: DYN, loc });
    const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
    const value = boxed(str("v"));
    const writes = (fn: IrLibFn, key: IrExpr, written: IrExpr = value): IrModule => {
      const mod = module();
      mod.functions[0]!.body.push(
        { kind: "varDecl", localId: "%key", init: key, loc },
        {
          kind: "exprStmt",
          loc,
          expr: {
            kind: "libCall",
            fn,
            args: [boxed(str("o")), { kind: "varRef", localId: "%key", type: DYN, loc }, written],
            type: VOID,
            loc,
          },
        },
      );
      return mod;
    };
    const selects = (fn: IrLibFn, key: IrExpr, written?: IrExpr): boolean =>
      moduleRuntimeFeatures(writes(fn, key, written)).sparseArrays;
    expect(selects("dyn.keySetComputed", boxed(num(2147483648)))).toBe(true);
    expect(selects("dyn.keySet", str("987654321"))).toBe(true);
    expect(selects("dyn.keySetComputed", boxed(num(7)))).toBe(false);
    expect(selects("dyn.keySet", str("012"))).toBe(false);
    expect(selects("dyn.keySetComputed", boxed(str("name")))).toBe(false);
    // A key computed at run time is not a proven index.
    expect(selects("dyn.keySetComputed", { kind: "varRef", localId: "k", type: DYN, loc })).toBe(
      false,
    );
    // A live view of a native array keeps its far slots out of line already
    // (the ScrArr ext), so a spelled far write through it selects nothing.
    const view = module();
    const native = arrayOf(DYN);
    view.functions[0]!.locals.push({ id: "%typed", name: "typed", mutable: false, type: native });
    view.functions[0]!.body.push(
      {
        kind: "varDecl",
        localId: "%view",
        init: boxed({ kind: "varRef", localId: "%typed", type: native, loc }),
        loc,
      },
      { kind: "varDecl", localId: "%key", init: boxed(num(3000001)), loc },
      {
        kind: "exprStmt",
        loc,
        expr: {
          kind: "libCall",
          fn: "dyn.keySetComputed",
          args: [
            { kind: "varRef", localId: "%view", type: DYN, loc },
            { kind: "varRef", localId: "%key", type: DYN, loc },
            value,
          ],
          type: VOID,
          loc,
        },
      },
    );
    expect(moduleRuntimeFeatures(view).sparseArrays).toBe(false);
    // A module-level `const view: any = typed` initializes its global with an
    // assign, and is the same live view.
    const globalView = module();
    globalView.functions[0]!.locals.push({
      id: "%typed",
      name: "typed",
      mutable: false,
      type: native,
    });
    globalView.functions[0]!.body.push(
      {
        kind: "assign",
        localId: "%view",
        value: boxed({ kind: "varRef", localId: "%typed", type: native, loc }),
        initializes: true,
        loc,
      },
      { kind: "varDecl", localId: "%key", init: boxed(num(3000001)), loc },
      {
        kind: "exprStmt",
        loc,
        expr: {
          kind: "libCall",
          fn: "dyn.keySetComputed",
          args: [
            { kind: "varRef", localId: "%view", type: DYN, loc },
            { kind: "varRef", localId: "%key", type: DYN, loc },
            value,
          ],
          type: VOID,
          loc,
        },
      },
    );
    expect(moduleRuntimeFeatures(globalView).sparseArrays).toBe(false);
    // `length` moves where the prefix ends, so the spelled value decides.
    expect(selects("dyn.keySet", str("length"), boxed(num(5000000)))).toBe(true);
    expect(selects("dyn.keySet", str("length"), boxed(num(8)))).toBe(false);
    expect(selects("dyn.keyDelete" as IrLibFn, str("987654321"))).toBe(false);
  });

  test("selects the function-property build for a spelled protocol member", () => {
    // A function may carry an own data property named after an inherited
    // member (`fn.call = f`). The runtime paths that admit it live in the
    // SCR_FN_MEMBER_PROPS builds of scr_json.c and scr_dyn_invoke.c, so the
    // fact follows the member name a keyed write, definition or delete
    // spells; an ordinary expando write and a plain definition of a name
    // every object literal defines select the default objects. A definition
    // also follows the receiver: a typed callable, a class value or a
    // checked-dynamic value (which may hold an any-typed function) can reach
    // the function path, a boxed non-callable cannot.
    const boxed = (value: IrExpr): IrExpr => ({ kind: "dynFrom", value, type: DYN, loc });
    const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
    const receiver: IrExpr = { kind: "varRef", localId: "o", type: DYN, loc };
    const fnValue: IrExpr = {
      kind: "varRef",
      localId: "f",
      type: { kind: "func", params: [], ret: VOID },
      loc,
    };
    const op = (fn: IrLibFn, target: IrExpr, key: IrExpr): IrModule => {
      const mod = module();
      mod.functions[0]!.body.push({
        kind: "exprStmt",
        loc,
        expr: {
          kind: "libCall",
          fn,
          args: [target, key, boxed(str("v"))],
          type: fn.startsWith("dyn.define") ? DYN : VOID,
          loc,
        },
      });
      return mod;
    };
    const selects = (fn: IrLibFn, target: IrExpr, key: IrExpr): boolean =>
      moduleRuntimeFeatures(op(fn, target, key)).fnMemberProps;
    expect(moduleRuntimeFeatures(module()).fnMemberProps).toBe(false);
    expect(selects("dyn.keySet", receiver, str("call"))).toBe(true);
    expect(selects("dyn.keySet", receiver, str("apply"))).toBe(true);
    // The keyed write evaluates its key into a hidden local first.
    const local = op("dyn.keySet", receiver, { kind: "varRef", localId: "%key", type: DYN, loc });
    local.functions[0]!.body.unshift({
      kind: "varDecl",
      localId: "%key",
      init: boxed(str("bind")),
      loc,
    });
    expect(moduleRuntimeFeatures(local).fnMemberProps).toBe(true);
    expect(selects("dyn.keyDelete", receiver, str("valueOf"))).toBe(true);
    // An expando member and a name a plain object literal defines select
    // nothing: their writes never reach the function-property path.
    expect(selects("dyn.keySet", receiver, str("extra"))).toBe(false);
    expect(selects("dyn.defineProperty", receiver, boxed(str("toString")))).toBe(false);
    // A definition on a boxed callable creates the own property Node does.
    expect(selects("dyn.defineProperty", boxed(fnValue), boxed(str("bind")))).toBe(true);
    // A class value's own protocol member is an own property too: its
    // runtime node is the constructor function.
    const classValue: IrExpr = {
      kind: "varRef",
      localId: "C",
      type: { kind: "classval", className: "C" },
      loc,
    };
    expect(selects("dyn.defineProperty", boxed(classValue), boxed(str("call")))).toBe(true);
    // A checked-dynamic receiver names no kind at all, so an any-typed
    // function among its values reaches the definition as one: the build
    // that admits the own property must be selected, not whichever unrelated
    // statement happens to select it.
    expect(selects("dyn.defineProperty", receiver, boxed(str("call")))).toBe(true);
    expect(selects("dyn.definePropertyShapes", receiver, boxed(str("apply")))).toBe(true);
    expect(
      selects(
        "dyn.defineProperty",
        { kind: "dynFrom", value: receiver, type: DYN, loc },
        boxed(str("bind")),
      ),
    ).toBe(true);
    // A boxed receiver of a non-callable type is an object at run time, so
    // its definition keeps the default objects.
    const recordValue: IrExpr = {
      kind: "varRef",
      localId: "o",
      type: { kind: "record", shapeId: "r0" },
      loc,
    };
    expect(selects("dyn.defineProperty", boxed(recordValue), boxed(str("constructor")))).toBe(
      false,
    );
    expect(
      selects(
        "dyn.defineProperty",
        { kind: "varRef", localId: "b", type: { kind: "bytes", elem: "u8" }, loc },
        boxed(str("valueOf")),
      ),
    ).toBe(false);
    // Every `Object.defineProperty` on a dynamic target is lifted into the
    // class-dispatch helper, whose own `dyn.defineProperty` call sees only
    // parameters. The call site still spells the key, so the definition is
    // read from the call into the helper.
    const lifted = (target: IrExpr, key: IrExpr): boolean => {
      const mod = module();
      mod.functions[0]!.body.push({
        kind: "exprStmt",
        loc,
        expr: {
          kind: "call",
          callee: "%dyn.class.defineProperty",
          args: [target, key, boxed(str("v"))],
          type: DYN,
          loc,
        },
      });
      return moduleRuntimeFeatures(mod).fnMemberProps;
    };
    expect(lifted(receiver, boxed(str("call")))).toBe(true);
    expect(lifted(boxed(fnValue), boxed(str("apply")))).toBe(true);
    expect(lifted(boxed(classValue), boxed(str("bind")))).toBe(true);
    expect(lifted(boxed(recordValue), boxed(str("constructor")))).toBe(false);
    expect(lifted(receiver, boxed(str("toString")))).toBe(false);
    expect(lifted(receiver, { kind: "varRef", localId: "k", type: DYN, loc })).toBe(false);
    // A key computed at run time cannot be proven a protocol member.
    expect(
      selects("dyn.keySetComputed", receiver, { kind: "varRef", localId: "k", type: DYN, loc }),
    ).toBe(false);
    // The hidden key local is function-scope: `%setKey.0` names a different
    // value in the next function, so neither declaration answers the other.
    const sibling = (name: string): IrFunction => ({
      name,
      params: [],
      locals: [],
      returnType: VOID,
      loc,
      body: [{ kind: "varDecl", localId: "%setKey.0", init: boxed(str("call")), loc }],
    });
    const own = module();
    own.functions[0]!.body.push(
      { kind: "varDecl", localId: "%setKey.0", init: boxed(str("extra")), loc },
      {
        kind: "exprStmt",
        loc,
        expr: {
          kind: "libCall",
          fn: "dyn.keySet",
          args: [
            receiver,
            { kind: "varRef", localId: "%setKey.0", type: STRING, loc },
            boxed(str("v")),
          ],
          type: VOID,
          loc,
        },
      },
    );
    expect(moduleRuntimeFeatures(own).fnMemberProps).toBe(false);
    own.functions.push(sibling("other"));
    expect(moduleRuntimeFeatures(own).fnMemberProps).toBe(false);
  });

  test("selects the function-property build for a spelled read of an inherited member", () => {
    // A function inherits `call`, `bind` and `toString`; the default build of
    // scr_json.c reads the member itself as undefined, and only the
    // SCR_FN_MEMBER_PROPS build has a value for it. A dynamic read that
    // spells `call` or `bind` selects that build. `apply` has a value in
    // every build, a key computed at run time proves nothing, and a read of
    // `toString` is what `String(value)` lowers to, so it selects nothing:
    // a delete of `toString`, which reveals the inherited member, does.
    const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
    const receiver: IrExpr = { kind: "varRef", localId: "o", type: DYN, loc };
    const reads = (key: IrExpr): boolean => {
      const mod = module();
      mod.functions[0]!.body.push({
        kind: "exprStmt",
        loc,
        expr: { kind: "dynKeyGet", value: receiver, key, type: DYN, loc },
      });
      return moduleRuntimeFeatures(mod).fnMemberProps;
    };
    expect(reads(str("call"))).toBe(true);
    expect(reads(str("bind"))).toBe(true);
    expect(reads(str("toString"))).toBe(false);
    expect(reads(str("apply"))).toBe(false);
    expect(reads(str("valueOf"))).toBe(false);
    expect(reads(str("extra"))).toBe(false);
    expect(reads({ kind: "varRef", localId: "k", type: DYN, loc })).toBe(false);
    // A literal bracket key is boxed into the dynamic tier (`fn["call"]`).
    const boxedKey = (value: string): IrExpr => ({
      kind: "dynFrom",
      value: str(value),
      type: DYN,
      loc,
    });
    expect(reads(boxedKey("call"))).toBe(true);
    expect(reads(boxedKey("bind"))).toBe(true);
    expect(reads(boxedKey("toString"))).toBe(false);
    // The read counts wherever the function holds it.
    const nested = module();
    nested.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "libCall",
        fn: "dyn.typeof",
        args: [{ kind: "dynKeyGet", value: receiver, key: str("call"), type: DYN, loc }],
        type: STRING,
        loc,
      },
    });
    expect(moduleRuntimeFeatures(nested).fnMemberProps).toBe(true);
    const keyed = (fn: IrLibFn, name: string): boolean => {
      const mod = module();
      mod.functions[0]!.body.push({
        kind: "exprStmt",
        loc,
        expr: {
          kind: "libCall",
          fn,
          args: [receiver, str(name), { kind: "boolLit", value: true, type: BOOL, loc }],
          type: VOID,
          loc,
        },
      });
      return moduleRuntimeFeatures(mod).fnMemberProps;
    };
    expect(keyed("dyn.keyDelete", "toString")).toBe(true);
    // An own `toString` is an ordinary property in the default build.
    expect(keyed("dyn.keySet", "toString")).toBe(false);
    expect(keyed("dyn.keyDelete", "extra")).toBe(false);
  });

  test("arms the host-global check for a computed global read and `in`", () => {
    // A computed read of the global object, or `… in globalThis`, links the
    // derived name table's runtime check (scr_global_host_absent.c) and the
    // SCR_GLOBAL_HOST_ABSENT build of scr_node_builtin.c.
    for (const fn of ["global.hostAbsent", "dyn.globalHas"] as const) {
      const mod = module();
      mod.functions[0]!.body.push(call(fn));
      const features = moduleRuntimeFeatures(mod);
      expect(features.hostAbsentGlobals, fn).toBe(true);
      expect(features.jsObjectModel, fn).toBe(false);
    }
    expect(moduleRuntimeFeatures(module()).hostAbsentGlobals).toBe(false);
  });

  test("links the stderr reporter for a fence that stands for a deferred diagnostic", () => {
    // A runtimeFence whose message carries its diagnostic's tag throws
    // through scr_deferred_fence.c; the traps the lowering writes itself
    // (no tag) leave the program without the unit.
    const fenced = (message: string, file = "/app/a.js") => {
      const mod = module();
      mod.functions[0]!.body.push({
        kind: "runtimeFence",
        code: "SC2020",
        message,
        loc: { ...loc, file },
      });
      return moduleRuntimeFeatures(mod).deferredFence;
    };
    expect(fenced("'unescape' has no scriptc lowering yet [SC2020 at /app/a.js:4]")).toBe(true);
    expect(fenced("'unescape' has no scriptc lowering yet [SC2020]")).toBe(true);
    expect(fenced("reading 'x' through an untyped value is not supported")).toBe(false);
    // A TypeScript source's fences keep the plain throw.
    expect(fenced("an undefined index [SC2020 at /app/a.ts:4]", "/app/a.ts")).toBe(false);
    expect(moduleRuntimeFeatures(module()).deferredFence).toBe(false);
    // So do a library's: its archive carries no reporter.
    const library = module();
    library.lib = { profileName: "p" } as NonNullable<IrModule["lib"]>;
    library.functions[0]!.body.push({
      kind: "runtimeFence",
      code: "SC2020",
      message: "'unescape' has no scriptc lowering yet [SC2020 at /app/a.js:4]",
      loc: { ...loc, file: "/app/a.js" },
    });
    expect(moduleRuntimeFeatures(library).deferredFence).toBe(false);
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

  test("gates the spawn error's errnoException fields on reading it", () => {
    // The `.error` read is what selects scr_child.c's SCR_CHILD_ERR_FIELDS
    // build; a program that only spawns keeps the default object.
    const reader = module();
    reader.functions[0]!.body.push(call("spawnRes.error"));
    expect(moduleRuntimeFeatures(reader)).toMatchObject({
      childProcess: true,
      childErrorFields: true,
    });

    const spawner = module();
    spawner.functions[0]!.locals.push({
      id: "r",
      name: "r",
      mutable: false,
      type: { kind: "spawnRes" },
    });
    expect(moduleRuntimeFeatures(spawner)).toMatchObject({
      childProcess: true,
      childErrorFields: false,
    });
  });

  test("gates Node's pipe lifecycle on a pipe, an unpipe or a pipeline", () => {
    // A stream program that never pipes links the stream unit alone.
    const writer = module();
    writer.functions[0]!.body.push(call("writable.write"));
    expect(moduleRuntimeFeatures(writer)).toMatchObject({ stream: true, streamPipeEvents: false });

    const piping = ["readable.pipe", "readable.unpipe", "stream.pipeline", "sp.pipeline"] as const;
    for (const fn of piping) {
      const mod = module();
      mod.functions[0]!.body.push(call(fn));
      expect(moduleRuntimeFeatures(mod).streamPipeEvents).toBe(true);
    }

    // A member named pipe called on an untyped value can reach a native
    // stream's own method.
    const untyped = module();
    untyped.functions[0]!.body.push({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynInvoke",
        recv: { kind: "unitLit", unit: "undefined", type: DYN, loc },
        method: "pipe",
        calleeName: "source.pipe",
        args: [],
        type: DYN,
        loc,
      },
    });
    expect(moduleRuntimeFeatures(untyped).streamPipeEvents).toBe(true);
  });

  test("gates the terminal color methods on a held process stream and one of their names", () => {
    const invoke = (method: string): IrStmt => ({
      kind: "exprStmt",
      loc,
      expr: {
        kind: "dynInvoke",
        recv: { kind: "unitLit", unit: "undefined", type: DYN, loc },
        method,
        calleeName: `out.${method}`,
        args: [],
        type: DYN,
        loc,
      },
    });
    // A program that holds the stream object and names neither method keeps
    // the default events unit.
    const holder = module();
    holder.functions[0]!.body.push(call("process.stdio"), invoke("getWindowSize"));
    expect(moduleRuntimeFeatures(holder)).toMatchObject({ stdioObject: true, ttyColors: false });

    // The name alone, without a stream object to read it from, selects
    // nothing.
    const named = module();
    named.functions[0]!.body.push(invoke("hasColors"));
    expect(moduleRuntimeFeatures(named).ttyColors).toBe(false);

    for (const method of ["getColorDepth", "hasColors"]) {
      const calling = module();
      calling.functions[0]!.body.push(call("process.stdio"), invoke(method));
      expect(moduleRuntimeFeatures(calling).ttyColors, method).toBe(true);

      // A member read by name, or a computed key that is a literal.
      const reading = module();
      reading.functions[0]!.body.push(call("process.stdioSlot"), {
        kind: "exprStmt",
        loc,
        expr: { kind: "strLit", value: method, type: { kind: "string" }, loc },
      });
      expect(moduleRuntimeFeatures(reading).ttyColors, method).toBe(true);
    }
  });

  test("gates the process.features object on reading it as a value", () => {
    // Member reads are constants; only the value form links the unit.
    const reader = module();
    reader.functions[0]!.body.push(call("process.features"));
    expect(moduleRuntimeFeatures(reader).processFeatures).toBe(true);
    expect(moduleRuntimeFeatures(module()).processFeatures).toBe(false);
  });

  test("gates a child stream's flowing state on pausing, resuming or reading it", () => {
    // Each of the four members selects scr_child.c's SCR_CHILD_STREAM_FLOW
    // build; a program that only listens to a child's output keeps the
    // default object.
    for (const fn of [
      "stream.childPause",
      "stream.childResume",
      "stream.childIsPaused",
      "stream.childFlowing",
    ] as const) {
      const flow = module();
      flow.functions[0]!.body.push(call(fn));
      expect(moduleRuntimeFeatures(flow).childStreamFlow).toBe(true);
    }

    const listener = module();
    listener.functions[0]!.body.push(call("stream.onEnd"));
    expect(moduleRuntimeFeatures(listener).childStreamFlow).toBe(false);
  });

  test("gates the fs streams' signal option on options that can hold one", () => {
    // The `...Signal` entries select scr_fs_stream.c's SCR_FS_STREAM_SIGNAL
    // build and the event-target unit its abort listener comes from; the
    // plain entries keep the default fs stream unit and link no event target.
    for (const fn of [
      "fs.createReadStreamSignal",
      "fs.createWriteStreamSignal",
      "fileHandle.createReadStreamSignal",
      "fileHandle.createWriteStreamSignal",
    ] as const) {
      const mod = module();
      mod.functions[0]!.body.push(call(fn));
      expect(moduleRuntimeFeatures(mod)).toMatchObject({
        stream: true,
        fsStreamSignal: true,
        eventTarget: true,
      });
    }
    for (const fn of ["fs.createReadStream", "fileHandle.createWriteStream"] as const) {
      const mod = module();
      mod.functions[0]!.body.push(call(fn));
      expect(moduleRuntimeFeatures(mod)).toMatchObject({
        stream: true,
        fsStreamSignal: false,
        eventTarget: false,
      });
    }
  });

  test("installs a failed spawn's error object only where an 'error' listener can be registered", () => {
    // The fact decides the emitted scr_child_error_event_install call: a
    // program that only spawns keeps the settle path's hook empty and links
    // none of the property code.
    for (const fn of ["child.onError", "child.onDyn", "child.propsOnDyn"] as const) {
      const listener = module();
      listener.functions[0]!.body.push(call(fn));
      expect(moduleRuntimeFeatures(listener)).toMatchObject({
        childProcess: true,
        childErrorEvent: true,
      });
    }

    // A child that becomes an untyped value can be listened to through the
    // handle table.
    const boxed = module();
    boxed.functions[0]!.body.push({
      kind: "exprStmt",
      expr: {
        kind: "dynFrom",
        value: { kind: "varRef", localId: "c", type: { kind: "child" }, loc },
        type: { kind: "dyn" },
        loc,
      },
      loc,
    });
    expect(moduleRuntimeFeatures(boxed).childErrorEvent).toBe(true);

    const spawner = module();
    spawner.functions[0]!.body.push(call("child.onExit"));
    expect(moduleRuntimeFeatures(spawner)).toMatchObject({
      childProcess: true,
      childErrorEvent: false,
    });
  });

  test("links the adoption unit for a typed slot's flagged conversion, not for a boxed function", () => {
    const names = arrayOf(STRING);
    const takesNames: IrType = { kind: "func", params: [names], ret: VOID };
    const links = (flagged: boolean): boolean => {
      const mod = module();
      mod.functions[0]!.locals.push(
        { id: "fn", name: "fn", mutable: false, type: takesNames },
        { id: "source", name: "source", mutable: false, type: DYN },
      );
      // A function boxed for untyped code: its thunk converts the caller's
      // array and keeps the copy, so it does not ask for the unit.
      const boxed: IrExpr = {
        kind: "dynFrom",
        type: DYN,
        loc,
        value: { kind: "varRef", localId: "fn", type: takesNames, loc },
      };
      const check: IrExpr & { kind: "dynCheck" } = {
        kind: "dynCheck",
        type: names,
        loc,
        value: { kind: "varRef", localId: "source", type: DYN, loc },
      };
      if (flagged) check.shared = true;
      mod.functions[0]!.body.push(
        { kind: "exprStmt", loc, expr: boxed },
        { kind: "exprStmt", loc, expr: check },
      );
      return moduleRuntimeFeatures(mod).declAdopt;
    };
    expect(links(true)).toBe(true);
    expect(links(false)).toBe(false);
  });
});
