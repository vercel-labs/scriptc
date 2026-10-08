import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  DYN_CLASS_PROPERTIES,
  F64,
  NULL_T,
  STRING,
  SYMBOL_T,
  UNDEFINED_T,
  VOID,
  arrayOf,
  mapOf,
  setOf,
  type IrExpr,
  type IrModule,
  type IrType,
  type IrUnionDef,
} from "./ir.js";
import { deserializeModule, serializeModule } from "./serialize.js";
import { validateModule } from "./validate.js";

const loc = { file: "numeric-read.ts", start: 0, end: 0 };

test("static callback operations validate their complete ABI after serialization", () => {
  const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, []);
  mod.ffiImports = [
    {
      name: "register",
      symbol: "register",
      library: "native",
      callbackOperation: "register",
      params: [
        {
          callback: {
            id: "callback",
            params: ["pointer"],
            returns: "void",
            lifetime: "retained",
            invoke: "script-thread",
          },
        },
      ],
      returns: "pointer",
    },
    {
      name: "release",
      symbol: "release",
      library: "native",
      callbackOperation: "release",
      callbackTarget: "register",
      params: [],
      returns: "void",
    },
  ];
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  for (const variant of ["target", "library", "return", "params", "callback-id"]) {
    const bad = structuredClone(mod);
    const registration = bad.ffiImports![0]!;
    const release = bad.ffiImports![1]!;
    if (variant === "target") release.callbackTarget = "missing";
    if (variant === "library") release.library = "different";
    if (variant === "return") registration.returns = "void";
    if (variant === "params") release.params = ["pointer"];
    if (variant === "callback-id")
      (registration.params[0] as { callback: { id: string } }).callback.id = "wrong";
    expect(
      validateModule(bad).some((error) => error.message.includes("FFI callback operation")),
    ).toBe(true);
  }
});

function localClassModule(): IrModule {
  const self: IrType = { kind: "object", className: "Local" };
  const mod = expressionModule(
    {
      kind: "classRef",
      className: "Local",
      captures: ["outer"],
      type: { kind: "classval", className: "Local" },
      loc,
    },
    [],
  );
  mod.classes = [
    {
      name: "Local",
      jsName: "Local",
      fields: [{ name: "%classEnvironment:Local", type: { kind: "classval", className: "Local" } }],
      localCaptures: [{ localId: "shared", name: "value", type: F64 }],
      loc,
    },
  ];
  mod.functions[0]!.locals = [
    { id: "outer", name: "value", type: F64, mutable: true, boxed: true },
  ];
  mod.functions.push({
    name: "%Local.constructor",
    params: [{ localId: "self", name: "this", type: self }],
    locals: [
      { id: "self", name: "this", type: self, mutable: false },
      { id: "capture", name: "value", type: F64, mutable: true, boxed: true },
    ],
    classCaptures: [{ localId: "capture", name: "value", type: F64, slot: 0 }],
    returnType: VOID,
    body: [],
    loc,
  });
  return mod;
}

test("serialized field presence tracking requires native property storage", () => {
  const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, []);
  mod.classes = [
    {
      name: "Value",
      fields: [{ name: DYN_CLASS_PROPERTIES, type: DYN }],
      tracksOwnFields: true,
      loc,
    },
  ];
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  for (const variant of ["missing", "type", "runtime"]) {
    const bad = structuredClone(mod);
    const cls = bad.classes![0]!;
    if (variant === "missing") cls.fields = [];
    if (variant === "type") cls.fields[0]!.type = F64;
    if (variant === "runtime") cls.runtime = true;
    expect(
      validateModule(bad).some((error) => error.message.includes("field presence tracking")),
    ).toBe(true);
  }
});

test("class prototype data helpers retain their ABI after serialization", () => {
  const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, []);
  mod.classes = [{ name: "Vector", fields: [], prototypeDataHelper: "%prototype.Vector", loc }];
  mod.functions.push({
    name: "%prototype.Vector",
    params: [],
    locals: [],
    returnType: DYN,
    body: [{ kind: "return", value: { kind: "dynObjLit", fields: [], type: DYN, loc }, loc }],
    loc,
  });
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  for (const variant of ["missing", "params", "return", "captures"]) {
    const bad = structuredClone(mod);
    const helper = bad.functions[1]!;
    if (variant === "missing") bad.functions.pop();
    if (variant === "params") helper.params.push({ localId: "p", name: "p", type: DYN });
    if (variant === "return") helper.returnType = F64;
    if (variant === "captures") helper.captures = [];
    expect(
      validateModule(bad).some((error) => error.message.includes("prototype data helper")),
    ).toBe(true);
  }
});

test("local classes retain serialized capture slots and fresh identity", () => {
  const mod = localClassModule();
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
});

test("instance prototype helpers require the class receiver ABI", () => {
  const mod = localClassModule();
  mod.classes![0]!.instancePrototypeHelper = "%Local.prototype";
  const receiver: IrType = { kind: "object", className: "Local" };
  mod.functions.push({
    name: "%Local.prototype",
    params: [{ localId: "this", name: "this", type: receiver }],
    locals: [{ id: "this", name: "this", type: receiver, mutable: false }],
    returnType: DYN,
    body: [{ kind: "return", value: { kind: "dynObjLit", fields: [], type: DYN, loc }, loc }],
    loc,
  });
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  for (const variant of ["missing", "params", "receiver", "return", "captures"]) {
    const bad = structuredClone(mod);
    const helper = bad.functions.at(-1)!;
    if (variant === "missing") bad.functions.pop();
    if (variant === "params") helper.params = [];
    if (variant === "receiver") helper.params[0]!.type = DYN;
    if (variant === "return") helper.returnType = F64;
    if (variant === "captures") helper.captures = [];
    expect(
      validateModule(bad).some((error) => error.message.includes("instance prototype helper")),
    ).toBe(true);
  }
});

test("computed bases retain their constructor globals after serialization", () => {
  const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, []);
  mod.classes = [
    { name: "Base", fields: [], loc },
    { name: "Child", base: "Base", fields: [], baseValueGlobal: "%g.computed", loc },
  ];
  mod.globals = [
    {
      id: "%g.computed",
      name: "computed",
      type: { kind: "classval", className: "Base" },
      mutable: false,
    },
  ];
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  for (const variant of ["missing", "type", "class", "capture"]) {
    const bad = structuredClone(mod);
    if (variant === "missing") bad.globals = [];
    if (variant === "type") bad.globals![0]!.type = DYN;
    if (variant === "class") bad.globals![0]!.type = { kind: "classval", className: "Child" };
    if (variant === "capture") bad.classes![1]!.localBaseCapture = 0;
    expect(
      validateModule(bad).some((error) => error.message.includes("computed base global")),
    ).toBe(true);
  }
});

test("class symbol fields preserve their identity metadata after serialization", () => {
  const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, []);
  mod.classes = [
    {
      name: "Item",
      fields: [{ name: "sym:key", type: STRING }],
      symbolFields: [{ field: "sym:key", globalId: "%g.key" }],
      loc,
    },
  ];
  mod.globals = [{ id: "%g.key", name: "key", type: SYMBOL_T, mutable: false }];
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  for (const variant of ["global", "type", "field"]) {
    const bad = structuredClone(mod);
    if (variant === "global") bad.globals = [];
    if (variant === "type") bad.globals![0]!.type = STRING;
    if (variant === "field") bad.classes![0]!.fields = [];
    expect(
      validateModule(bad).some((error) => error.message.includes("symbol field metadata")),
    ).toBe(true);
  }
});

test.each(["missing", "unboxed", "type", "slot", "receiver", "closure", "layout", "direct-new"])(
  "local classes reject an invalid %s environment",
  (variant) => {
    const mod = localClassModule();
    const ctor = mod.functions[1]!;
    if (variant === "missing") mod.functions[0]!.locals = [];
    if (variant === "unboxed") delete mod.functions[0]!.locals[0]!.boxed;
    if (variant === "type") ctor.locals[1]!.type = STRING;
    if (variant === "slot") ctor.classCaptures![0]!.slot = 1;
    if (variant === "receiver") ctor.params[0]!.type = F64;
    if (variant === "closure") ctor.captures = [];
    if (variant === "layout") mod.classes![0]!.runtime = true;
    if (variant === "direct-new")
      mod.functions[0]!.body = [
        {
          kind: "exprStmt",
          expr: {
            kind: "new",
            className: "Local",
            args: [],
            type: { kind: "object", className: "Local" },
            loc,
          },
          loc,
        },
      ];
    expect(validateModule(mod).length).toBeGreaterThan(0);
  },
);

test.each([mapOf(STRING, F64), setOf(STRING), { kind: "promise", inner: F64 } as IrType])(
  "nullable %j payloads preserve an explicit absence tag",
  (type) => {
    const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, [
      { id: "nullable", arms: [type, NULL_T, UNDEFINED_T] },
    ]);
    expect(validateModule(mod)).toEqual([]);
    expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  },
);

test.each([{ kind: "promise", inner: F64 } as IrType])(
  "%j payloads still refuse unrelated data siblings",
  (type) => {
    const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, [
      { id: "mixed", arms: [type, STRING, UNDEFINED_T] },
    ]);
    expect(validateModule(mod).map((error) => error.message)).toContain(
      `union mixed: ${type.kind} arm 0 beside non-unit arms`,
    );
  },
);

test("differently typed collection payloads preserve separate union tags", () => {
  const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, [
    { id: "maps", arms: [mapOf(STRING, F64), mapOf(STRING, STRING), UNDEFINED_T] },
  ]);
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
});

function numericReadModule(overrides: Partial<IrExpr & { kind: "arrIntrinsic" }> = {}): IrModule {
  const read: IrExpr = {
    kind: "arrIntrinsic",
    method: "getNumber",
    receiver: { kind: "arrayLit", elems: [], type: arrayOf(F64), loc },
    args: [{ kind: "numLit", value: 0, type: F64, loc }],
    type: F64,
    loc,
    ...overrides,
  };
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [],
        locals: [],
        returnType: VOID,
        body: [{ kind: "exprStmt", expr: read, loc }],
        loc,
      },
    ],
  };
}

test.each(["copyWithin", "fill", "fillUndefined"] as const)(
  "indexed array mutation %s validates its serialized argument and result contract",
  (method) => {
    const number: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
    const value: IrExpr = { kind: "strLit", value: "entry", type: STRING, loc };
    const type = arrayOf(STRING);
    const expr: IrExpr & { kind: "arrIntrinsic" } = {
      kind: "arrIntrinsic",
      method,
      receiver: { kind: "arrayLit", elems: [], type, loc },
      args:
        method === "fill"
          ? [value, number, number]
          : method === "copyWithin"
            ? [number, number, number]
            : [number, number],
      type,
      loc,
    };
    const mod = expressionModule(expr, []);
    expect(validateModule(mod)).toEqual([]);
    expect(deserializeModule(serializeModule(mod))).toEqual(mod);
    for (const change of [
      { args: expr.args.slice(1) },
      { args: [...expr.args.slice(0, -1), value] },
      { args: [method === "fill" ? number : value, ...expr.args.slice(1)] },
      { type: arrayOf(F64) },
    ]) {
      const invalid = expressionModule({ ...expr, ...change }, []);
      expect(validateModule(deserializeModule(serializeModule(invalid))).length).toBeGreaterThan(0);
    }
  },
);

test.each(["sortPrimitive", "toSortedPrimitive"] as const)(
  "primitive ordering %s validates its serialized element and result contract",
  (method) => {
    for (const elem of [STRING, F64, BOOL]) {
      const type = arrayOf(elem);
      const expr: IrExpr & { kind: "arrIntrinsic" } = {
        kind: "arrIntrinsic",
        method,
        receiver: { kind: "arrayLit", elems: [], type, loc },
        args: [],
        type,
        loc,
      };
      const mod = expressionModule(expr, []);
      expect(validateModule(mod)).toEqual([]);
      expect(deserializeModule(serializeModule(mod))).toEqual(mod);
      for (const change of [
        { args: [{ kind: "numLit" as const, value: 1, type: F64, loc }] },
        { type: F64 },
        {
          receiver: { kind: "arrayLit" as const, elems: [], type: arrayOf(type), loc },
          type: arrayOf(type),
        },
      ]) {
        expect(validateModule(expressionModule({ ...expr, ...change }, [])).length).toBeGreaterThan(
          0,
        );
      }
    }
  },
);

function expressionModule(expr: IrExpr, unions: IrUnionDef[]): IrModule {
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    unions,
    functions: [
      {
        name: "main",
        params: [],
        locals: [],
        returnType: VOID,
        body: [{ kind: "exprStmt", expr, loc }],
        loc,
      },
    ],
  };
}

test("numeric byte tokens and DataView stores validate their storage before emission", () => {
  const bytes: IrExpr = {
    kind: "varRef",
    localId: "bytes",
    type: { kind: "bytes", elem: "u8" },
    loc,
  };
  const number: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
  const kind: IrExpr = { kind: "strLit", value: "u32le", type: STRING, loc };
  const read: IrExpr = {
    kind: "bytesIntrinsic",
    method: "readNum",
    receiver: bytes,
    args: [kind, number],
    type: F64,
    loc,
  };
  const mod = expressionModule(read, []);
  mod.functions[0]!.locals.push({ id: "bytes", name: "bytes", type: bytes.type, mutable: false });
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  for (const value of ["toString", "u64le", "u8be"]) {
    kind.value = value;
    expect(validateModule(mod).some((e) => e.message.includes("invalid kind token"))).toBe(true);
  }
  kind.value = "u32le";
  const store: IrExpr = {
    kind: "bytesIntrinsic",
    method: "dvSetUint32",
    receiver: bytes,
    args: [number, number],
    type: VOID,
    loc,
  };
  mod.functions[0]!.body = [{ kind: "exprStmt", expr: store, loc }];
  expect(validateModule(mod)).toEqual([]);
  bytes.type = { kind: "bytes", elem: "u32" };
  mod.functions[0]!.locals[0]!.type = bytes.type;
  expect(validateModule(mod).some((e) => e.message.includes("u8 only"))).toBe(true);
});

test("record declarations accept forward, mutual, and self references and refresh missing IDs", () => {
  const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, []);
  mod.records = [
    { id: "first", fields: [{ name: "next", type: { kind: "record", shapeId: "second" } }] },
    { id: "second", fields: [{ name: "next", type: { kind: "record", shapeId: "first" } }] },
    { id: "self", fields: [{ name: "next", type: { kind: "record", shapeId: "self" } }] },
  ];
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  mod.records[1]!.fields.unshift({ name: "missing", type: { kind: "record", shapeId: "later" } });
  expect(validateModule(mod)).toEqual([
    { message: 'record second: field "missing" references undeclared shape "later"', loc },
  ]);
  mod.records.push({ id: "later", fields: [] });
  expect(validateModule(mod)).toEqual([]);
});

function recordValidationModule(): IrModule {
  const type: IrType = { kind: "record", shapeId: "row" };
  const source: IrExpr = { kind: "varRef", localId: "row", type, loc };
  const mod = expressionModule(
    { kind: "recordGet", obj: source, shapeId: "row", field: "value", type: STRING, loc },
    [],
  );
  mod.records = [{ id: "row", fields: [{ name: "value", type: STRING }] }];
  mod.functions[0]!.locals = [{ id: "row", name: "row", type, mutable: false }];
  mod.functions[0]!.params = [{ localId: "row", name: "row", type }];
  mod.functions[0]!.body.push(
    {
      kind: "recordSet",
      obj: source,
      shapeId: "row",
      field: "value",
      value: { kind: "strLit", value: "write", type: STRING, loc },
      loc,
    },
    {
      kind: "exprStmt",
      expr: {
        kind: "recordClone",
        source,
        overrides: [
          { name: "value", value: { kind: "strLit", value: "clone", type: STRING, loc } },
        ],
        type,
        loc,
      },
      loc,
    },
  );
  return mod;
}

test("record validation preserves first-field reads and writes and last-field initialization on duplicate declarations", () => {
  const mod = recordValidationModule();
  expect(validateModule(mod)).toEqual([]);
  mod.records!.unshift({ id: "row", fields: [{ name: "value", type: BOOL }] });
  mod.records![1]!.fields.push({ name: "value", type: F64 });
  const statement = mod.functions[0]!.body[2]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "recordClone")
    throw new Error("fixture");
  statement.expr.overrides[0]!.value = { kind: "numLit", value: 1, type: F64, loc };
  mod.functions[0]!.body.push({
    kind: "exprStmt",
    expr: {
      kind: "recordLit",
      type: statement.expr.type,
      loc,
      fields: [1, 2].map((value) => ({
        name: "value",
        value: { kind: "numLit", value, type: F64, loc },
      })),
    },
    loc,
  });
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([
    { message: 'duplicate record shape "row"', loc },
    { message: 'record row: duplicate field "value"', loc },
    { message: 'in main: recordLit initializes field "value" twice', loc },
  ]);
});

test("record validation refreshes field types and missing members between invocations", () => {
  const mod = recordValidationModule();
  expect(validateModule(mod)).toEqual([]);
  mod.records![0]!.fields[0]!.type = F64;
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    "in main: recordGet row.value type mismatch",
    "in main: recordSet row.value: expected f64, got string",
    'in main: recordClone field "value": expected f64, got string',
  ]);
  mod.records![0]!.fields = [];
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    'in main: shape row has no field "value"',
    'in main: shape row has no field "value"',
    'in main: shape row has no field "value"',
  ]);
});

test("record clone validation refreshes accessor boundaries and preserves call-site locations across functions", () => {
  const mod = recordValidationModule();
  const statement = mod.functions[0]!.body[2]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "recordClone")
    throw new Error("fixture");
  mod.functions[0]!.body = [statement];
  mod.functions.push({ ...structuredClone(mod.functions[0]!), name: "other" });
  const other = mod.functions[1]!.body[0]!;
  if (other.kind !== "exprStmt") throw new Error("fixture");
  other.expr.loc = { ...loc, start: 10, end: 20 };
  expect(validateModule(mod)).toEqual([]);
  mod.records![0]!.fields.unshift({ name: "%get:value", type: F64 });
  expect(validateModule(mod)).toEqual([
    { message: "in main: recordClone requires a plain declared-field shape, got row", loc },
    {
      message: "in other: recordClone requires a plain declared-field shape, got row",
      loc: other.expr.loc,
    },
  ]);
});

function classFieldModule(): IrModule {
  const type: IrType = { kind: "object", className: "Value" };
  const source: IrExpr = { kind: "varRef", localId: "object", type, loc };
  const union: IrType = { kind: "union", unionId: "variants" };
  const mod = expressionModule(
    { kind: "fieldGet", obj: source, className: "Value", field: "score", type: F64, loc },
    [{ id: "variants", arms: [type, { kind: "record", shapeId: "row" }] }],
  );
  mod.classes = [
    {
      name: "Value",
      fields: [
        { name: "score", type: F64 },
        { name: "dynamic", type: DYN },
      ],
      loc,
    },
  ];
  mod.records = [{ id: "row", fields: [{ name: "score", type: F64 }] }];
  mod.functions[0]!.params = [
    { localId: "object", name: "object", type },
    { localId: "variant", name: "variant", type: union },
  ];
  mod.functions[0]!.locals = [
    { id: "object", name: "object", type, mutable: false },
    { id: "variant", name: "variant", type: union, mutable: false },
  ];
  mod.functions[0]!.body.push(
    {
      kind: "fieldSet",
      obj: source,
      className: "Value",
      field: "score",
      value: { kind: "numLit", value: 1, type: F64, loc },
      loc,
    },
    {
      kind: "exprStmt",
      expr: {
        kind: "fieldIncDec",
        obj: source,
        className: "Value",
        field: "score",
        fieldDyn: false,
        op: "+",
        prefix: true,
        type: F64,
        loc,
      },
      loc,
    },
    {
      kind: "exprStmt",
      expr: {
        kind: "fieldIncDec",
        obj: source,
        className: "Value",
        field: "dynamic",
        fieldDyn: true,
        op: "-",
        prefix: false,
        type: F64,
        loc,
      },
      loc,
    },
    {
      kind: "exprStmt",
      expr: {
        kind: "unionDisc",
        value: { kind: "varRef", localId: "variant", type: union, loc },
        unionId: "variants",
        field: "score",
        type: F64,
        loc,
      },
      loc,
    },
  );
  return mod;
}

test("class field validation preserves last-class and first-field lookup on duplicate declarations", () => {
  const mod = classFieldModule();
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  mod.classes!.unshift({
    name: "Value",
    fields: [
      { name: "score", type: STRING },
      { name: "dynamic", type: F64 },
    ],
    loc,
  });
  mod.classes![1]!.fields.push({ name: "score", type: STRING }, { name: "dynamic", type: F64 });
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([
    { message: 'duplicate class "Value"', loc },
    { message: 'class Value: duplicate field "score"', loc },
    { message: 'class Value: duplicate field "dynamic"', loc },
  ]);
});

test("class field validation refreshes types, missing fields, and missing classes between invocations", () => {
  const mod = classFieldModule();
  expect(validateModule(mod)).toEqual([]);
  mod.classes![0]!.fields[0]!.type = STRING;
  mod.classes![0]!.fields[1]!.type = F64;
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    "in main: fieldGet Value.score type mismatch",
    "in main: fieldSet Value.score: expected string, got f64",
    "in main: fieldIncDec Value.score field/flag mismatch (string)",
    "in main: fieldIncDec Value.dynamic field/flag mismatch (f64)",
    'in main: unionDisc: arm 0 field "score" is string, not f64',
  ]);
  mod.classes![0]!.fields = [];
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    'in main: class Value has no field "score"',
    'in main: class Value has no field "score"',
    'in main: class Value has no field "score"',
    'in main: class Value has no field "dynamic"',
    'in main: unionDisc: arm 0 of variants has no field "score"',
  ]);
  mod.classes = [];
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    'in main: fieldGet on undeclared class "Value"',
    'in main: fieldSet on undeclared class "Value"',
    'in main: fieldIncDec on undeclared class "Value"',
    'in main: fieldIncDec on undeclared class "Value"',
    'in main: unionDisc: arm 0 of variants has no field "score"',
  ]);
});

test("class field validation shares inherited layouts across functions and preserves call-site diagnostics", () => {
  const mod = classFieldModule();
  mod.classes!.unshift({ name: "Base", fields: structuredClone(mod.classes![0]!.fields), loc });
  mod.classes![1]!.base = "Base";
  const other = structuredClone(mod.functions[0]!);
  other.name = "other";
  other.body = other.body.slice(0, 1);
  mod.functions.push(other);
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  const statement = other.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "fieldGet")
    throw new Error("fixture");
  statement.expr.loc = { ...loc, start: 10, end: 20 };
  statement.expr.type = STRING;
  statement.expr.obj = { kind: "numLit", value: 0, type: F64, loc };
  expect(validateModule(mod)).toEqual([
    { message: "in other: fieldGet receiver: expected object, got f64", loc },
    { message: "in other: fieldGet Value.score type mismatch", loc: statement.expr.loc },
  ]);
});

function virtualCallModule(): IrModule {
  const receiver: IrType = { kind: "object", className: "Base" };
  const mod = expressionModule({ kind: "numLit", value: 0, type: F64, loc }, []);
  mod.classes = [
    { name: "Base", fields: [], methods: ["run"], abstractMethods: ["run"], loc },
    { name: "Unrelated", fields: [], methods: ["run"], loc },
    { name: "First", base: "Base", fields: [], methods: ["run"], loc },
    { name: "Second", base: "Base", fields: [], methods: ["run"], loc },
  ];
  for (const name of ["Unrelated", "First", "Second"]) {
    mod.functions.push({
      name: `%${name}.run`,
      params: [{ localId: "self", name: "self", type: receiver }],
      locals: [{ id: "self", name: "self", type: receiver, mutable: false }],
      returnType: F64,
      body: [{ kind: "return", value: { kind: "numLit", value: 1, type: F64, loc }, loc }],
      loc,
    });
  }
  for (let i = 0; i < 2; i++) {
    const at = { ...loc, start: i + 1 };
    mod.functions.push({
      name: `caller${i}`,
      params: [{ localId: "self", name: "self", type: receiver }],
      locals: [{ id: "self", name: "self", type: receiver, mutable: false }],
      returnType: VOID,
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "virtualCall",
            className: "Base",
            method: "run",
            args: [{ kind: "varRef", localId: "self", type: receiver, loc: at }],
            type: F64,
            loc: at,
          },
          loc: at,
        },
      ],
      loc: at,
    });
  }
  return mod;
}

test("virtual-call validation preserves each call site's diagnostic and excludes unrelated classes", () => {
  const mod = virtualCallModule();
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  mod.classes = mod.classes!.filter((cls) => cls.name !== "First" && cls.name !== "Second");
  expect(validateModule(mod).map((error) => [error.loc.start, error.message])).toEqual([
    [1, "in caller0: virtualCall Base.run: no concrete override below the static class"],
    [1, "in caller0: virtualCall Base.run: no implementation function exists"],
    [2, "in caller1: virtualCall Base.run: no concrete override below the static class"],
    [2, "in caller1: virtualCall Base.run: no implementation function exists"],
  ]);
});

test("virtual-call validation resolves an abstract slot in class-table order and rechecks each ABI", () => {
  const mod = virtualCallModule();
  const second = mod.functions.find((fn) => fn.name === "%Second.run")!;
  second.returnType = STRING;
  second.body = [
    { kind: "return", value: { kind: "strLit", value: "second", type: STRING, loc }, loc },
  ];
  expect(validateModule(mod)).toEqual([]);
  mod.classes!.reverse();
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    "in caller0: virtualCall Base.run result type mismatch",
    "in caller1: virtualCall Base.run result type mismatch",
  ]);
  mod.classes!.reverse();
  const caller = mod.functions.find((fn) => fn.name === "caller1")!;
  const statement = caller.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "virtualCall")
    throw new Error("fixture");
  statement.expr.args.push({ kind: "boolLit", value: true, type: BOOL, loc });
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    "in caller1: virtualCall Base.run: 2 args, method expects 1",
  ]);
  statement.expr.args.pop();
  mod.functions = mod.functions.filter((fn) => fn.name !== "%First.run");
  second.returnType = F64;
  second.body = [{ kind: "return", value: { kind: "numLit", value: 1, type: F64, loc }, loc }];
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    'class First: missing method function "run"',
  ]);
});

test("virtual-call validation uses the nearest concrete ancestor instead of an override's ABI", () => {
  const mod = virtualCallModule();
  mod.classes!.unshift({ name: "Root", fields: [], methods: ["run"], loc });
  mod.classes!.find((cls) => cls.name === "Base")!.base = "Root";
  mod.functions.push({
    name: "%Root.run",
    params: [{ localId: "self", name: "self", type: { kind: "object", className: "Base" } }],
    locals: [
      { id: "self", name: "self", type: { kind: "object", className: "Base" }, mutable: false },
    ],
    returnType: STRING,
    body: [{ kind: "return", value: { kind: "strLit", value: "root", type: STRING, loc }, loc }],
    loc,
  });
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    "in caller0: virtualCall Base.run result type mismatch",
    "in caller1: virtualCall Base.run result type mismatch",
  ]);
  mod.classes!.find((cls) => cls.name === "Root")!.methods = [];
  expect(validateModule(mod)).toEqual([]);
});

test("erased generic families admit compatible object views without supplying virtual slots", () => {
  const concrete: IrType = { kind: "object", className: "Concrete" };
  const family: IrType = { kind: "object", className: "Family" };
  const mod = expressionModule(
    {
      kind: "upcast",
      value: { kind: "varRef", localId: "value", type: concrete, loc },
      type: family,
      loc,
    },
    [],
  );
  mod.functions[0]!.params = [{ localId: "value", name: "value", type: concrete }];
  mod.functions[0]!.locals = [{ id: "value", name: "value", type: concrete, mutable: false }];
  mod.classes = [
    { name: "Root", fields: [{ name: "value", type: F64 }], methods: [], loc },
    { name: "Family", base: "Root", fields: [{ name: "value", type: F64 }], methods: [], loc },
    { name: "Storage", base: "Root", fields: [{ name: "value", type: F64 }], methods: [], loc },
    {
      name: "Concrete",
      base: "Storage",
      genericOf: "Family",
      fields: [{ name: "value", type: F64 }],
      methods: [],
      loc,
    },
  ];
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  mod.classes[3]!.fields[0]!.type = STRING;
  expect(validateModule(mod).map((error) => error.message)).toContain(
    'class Concrete: generic family "Family" has an incompatible prefix',
  );
  mod.classes[3]!.fields[0]!.type = F64;
  delete mod.classes[3]!.base;
  expect(validateModule(mod).map((error) => error.message)).toContain(
    'class Concrete: generic family "Family" has a different storage root',
  );
  mod.classes[3]!.base = "Storage";
  mod.classes[1]!.genericOf = "Concrete";
  expect(validateModule(mod).map((error) => error.message)).toContain(
    'class Concrete: generic family "Family" must name an erased declaration',
  );

  const calls = virtualCallModule();
  calls.classes = calls.classes!.filter((cls) => cls.name !== "Second");
  const first = calls.classes!.find((cls) => cls.name === "First")!;
  delete first.base;
  first.genericOf = "Base";
  expect(validateModule(calls).map((error) => error.message)).toContain(
    "in caller0: virtualCall Base.run: no concrete override below the static class",
  );
});

test("erased family membership cannot reinterpret a specialized constructor ABI", () => {
  const mod = expressionModule(
    {
      kind: "upcast",
      value: {
        kind: "varRef",
        localId: "ctor",
        type: { kind: "classval", className: "Concrete" },
        loc,
      },
      type: { kind: "classval", className: "Family" },
      loc,
    },
    [],
  );
  const ctor = { kind: "classval", className: "Concrete" } as const;
  mod.functions[0]!.params = [{ localId: "ctor", name: "ctor", type: ctor }];
  mod.functions[0]!.locals = [{ id: "ctor", name: "ctor", type: ctor, mutable: false }];
  mod.classes = [
    { name: "Family", fields: [], methods: [], loc },
    { name: "Concrete", genericOf: "Family", fields: [], methods: [], loc },
  ];
  expect(validateModule(mod).map((error) => error.message)).toContain(
    'in main: upcast: "Concrete" does not extend "Family"',
  );
});

test("library callbacks retain child, specialized, and generic result diagnostics", () => {
  const expr: IrExpr = {
    kind: "libCall",
    fn: "cp.execFile",
    type: F64,
    loc,
    args: [
      { kind: "strLit", value: "tool", type: STRING, loc },
      { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc },
      { kind: "boolLit", value: true, type: F64, loc },
    ],
  };
  expect(validateModule(expressionModule(expr, [])).map((error) => error.message)).toEqual([
    "in main: boolLit must be bool",
    "in main: libCall cp.execFile callback must be a non-rest void function with at most three parameters",
    "in main: libCall cp.execFile must be child, got f64",
  ]);
});

test("nullish chains retain child-before-parent diagnostic order", () => {
  const at = (start: number) => ({ ...loc, start });
  const expr: IrExpr = {
    kind: "nullish",
    type: F64,
    loc: at(4),
    left: {
      kind: "nullish",
      type: STRING,
      loc: at(2),
      left: { kind: "numLit", value: 0, type: STRING, loc: at(0) },
      right: { kind: "boolLit", value: true, type: F64, loc: at(1) },
    },
    right: { kind: "strLit", value: "wrong", type: F64, loc: at(3) },
  };
  expect(
    validateModule(expressionModule(expr, [])).map((error) => [error.loc.start, error.message]),
  ).toEqual([
    [0, "in main: numLit must be f64"],
    [1, "in main: boolLit must be bool"],
    [1, "in main: nullish right operand: expected string, got f64"],
    [2, "in main: nullish left must be a union, got string"],
    [3, "in main: strLit must be string"],
    [4, "in main: nullish left must be a union, got string"],
  ]);
});

test("logical trees retain left/right/parent diagnostic order", () => {
  const at = (start: number) => ({ ...loc, start });
  const expr: IrExpr = {
    kind: "logical",
    op: "&&",
    type: BOOL,
    loc: at(4),
    left: {
      kind: "logical",
      op: "||",
      type: STRING,
      loc: at(2),
      left: { kind: "numLit", value: 0, type: STRING, loc: at(0) },
      right: { kind: "boolLit", value: true, type: F64, loc: at(1) },
    },
    right: { kind: "strLit", value: "wrong", type: BOOL, loc: at(3) },
  };
  expect(
    validateModule(expressionModule(expr, [])).map((error) => [error.loc.start, error.message]),
  ).toEqual([
    [0, "in main: numLit must be f64"],
    [1, "in main: boolLit must be bool"],
    [1, "in main: logical || right: expected string, got f64"],
    [3, "in main: strLit must be string"],
    [2, "in main: logical && left: expected bool, got string"],
  ]);
});

test("conditional trees retain condition/then/else/parent diagnostic order", () => {
  const at = (start: number) => ({ ...loc, start });
  const expr: IrExpr = {
    kind: "ternary",
    type: STRING,
    loc: at(3),
    cond: { kind: "numLit", value: 0, type: BOOL, loc: at(0) },
    then: { kind: "boolLit", value: true, type: F64, loc: at(1) },
    else_: { kind: "strLit", value: "wrong", type: BOOL, loc: at(2) },
  };
  expect(
    validateModule(expressionModule(expr, [])).map((error) => [error.loc.start, error.message]),
  ).toEqual([
    [0, "in main: numLit must be f64"],
    [1, "in main: boolLit must be bool"],
    [2, "in main: strLit must be string"],
    [1, "in main: ternary then-branch: expected string, got f64"],
    [2, "in main: ternary else-branch: expected string, got bool"],
  ]);
});

test.each(["callValue", "dynCall"] as const)(
  "%s requires a checked-value receiver and preserves it in serialization",
  (kind) => {
    const funcType: IrType = { kind: "func", params: [], ret: DYN };
    const closure: IrExpr = {
      kind: "closure",
      fnName: "callback",
      captures: [],
      type: funcType,
      loc,
    };
    const receiver: IrExpr = {
      kind: "dynFrom",
      value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      type: DYN,
      loc,
    };
    const call: IrExpr =
      kind === "callValue"
        ? { kind, callee: closure, receiver, args: [], type: DYN, loc }
        : {
            kind,
            callee: { kind: "dynFrom", value: closure, type: DYN, loc },
            receiver,
            calleeName: "callback",
            args: [],
            type: DYN,
            loc,
          };
    const mod = expressionModule(call, []);
    mod.functions.push({
      name: "callback",
      params: [],
      locals: [],
      returnType: DYN,
      body: [{ kind: "return", value: receiver, loc }],
      loc,
    });
    expect(validateModule(mod)).toEqual([]);
    expect(deserializeModule(serializeModule(mod))).toEqual(mod);
    call.receiver = { kind: "numLit", value: 1, type: F64, loc };
    expect(validateModule(mod).some((error) => error.message.includes(`${kind} receiver`))).toBe(
      true,
    );
    call.receiver = { kind: "varRef", localId: "missing", type: DYN, loc };
    expect(validateModule(mod).some((error) => error.message.includes("missing"))).toBe(true);
  },
);

function optionalUnionModule(arms: IrType[] = [BOOL, F64, UNDEFINED_T]): IrModule {
  const type: IrType = { kind: "union", unionId: "receiver" };
  const tag = arms.findIndex((arm) => arm.kind === "f64");
  const receiver: IrExpr =
    tag >= 0
      ? {
          kind: "unionWrap",
          unionId: "receiver",
          tag,
          value: { kind: "numLit", value: 7, type: F64, loc },
          type,
          loc,
        }
      : {
          kind: "unionWrap",
          unionId: "receiver",
          tag: arms.findIndex((arm) => arm.kind === "undefinedT"),
          value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
          type,
          loc,
        };
  const chain: IrExpr = {
    kind: "optChain",
    id: "test",
    receiver,
    body: { kind: "chainRecv", id: "test", type, loc },
    type,
    loc,
  };
  return expressionModule(chain, [{ id: "receiver", arms }]);
}

test("optional chains over several value arms bind the tagged receiver", () => {
  const mod = optionalUnionModule();
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
});

test("optional chains reject bindings that discard a surviving variant", () => {
  const mod = optionalUnionModule();
  const statement = mod.functions[0]!.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "optChain")
    throw new Error("fixture");
  statement.expr.body = { kind: "chainRecv", id: "test", type: F64, loc };
  expect(validateModule(mod).some((error) => error.message.includes("chainRecv: expected"))).toBe(
    true,
  );
});

test.each([
  [BOOL, F64],
  [NULL_T, UNDEFINED_T],
])("optional chains need both a present and an absent path %#", (...arms) => {
  expect(
    validateModule(optionalUnionModule(arms)).some((error) =>
      error.message.includes("must have unit arms and at least one non-unit arm"),
    ),
  ).toBe(true);
});

test("a single present arm still binds its payload", () => {
  const mod = optionalUnionModule([F64, UNDEFINED_T]);
  expect(validateModule(mod).some((error) => error.message.includes("chainRecv: expected"))).toBe(
    true,
  );
  const statement = mod.functions[0]!.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "optChain")
    throw new Error("fixture");
  statement.expr.body = {
    kind: "unionWrap",
    unionId: "receiver",
    tag: 0,
    value: { kind: "chainRecv", id: "test", type: F64, loc },
    type: { kind: "union", unionId: "receiver" },
    loc,
  };
  expect(validateModule(mod)).toEqual([]);
});

function keyedUnionModule(resultArms: IrType[], overflowOnly = false): IrModule {
  const stored: IrType = { kind: "union", unionId: "stored" };
  const result: IrType = { kind: "union", unionId: "result" };
  const record: IrType = { kind: "record", shapeId: "row" };
  const obj: IrExpr = {
    kind: "recordLit",
    type: record,
    loc,
    fields: [
      {
        name: "value",
        value: {
          kind: "unionWrap",
          unionId: "stored",
          tag: 0,
          value: { kind: "numLit", value: 9, type: F64, loc },
          type: stored,
          loc,
        },
      },
    ],
  };
  const read: IrExpr = {
    kind: "recordKeyGet",
    obj,
    shapeId: "row",
    key: { kind: "strLit", value: overflowOnly ? "extra" : "value", type: STRING, loc },
    type: result,
    loc,
    ...(overflowOnly ? { overflowOnly: true as const } : {}),
  };
  const mod = expressionModule(read, [
    { id: "stored", arms: [F64, NULL_T] },
    { id: "result", arms: resultArms },
  ]);
  mod.records = [{ id: "row", fields: [{ name: "value", type: stored }], indexValue: stored }];
  return mod;
}

test.each([false, true])(
  "keyed union reads validate a payload-preserving widening (overflow=%s)",
  (overflow) => {
    const mod = keyedUnionModule([BOOL, F64, NULL_T, UNDEFINED_T], overflow);
    expect(validateModule(mod)).toEqual([]);
    expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  },
);

test.each([false, true])(
  "keyed union reads refuse to discard a stored arm (overflow=%s)",
  (overflow) => {
    const errors = validateModule(keyedUnionModule([F64, STRING, UNDEFINED_T], overflow));
    expect(
      errors.some((error) => error.message.includes("cannot surface as the result type")),
    ).toBe(true);
  },
);

test("union array reads validate every element layout against the joined result", () => {
  const stored: IrType = { kind: "union", unionId: "stored" };
  const receiver: IrType = { kind: "union", unionId: "arrays" };
  const result: IrType = { kind: "union", unionId: "result" };
  const array: IrExpr = {
    kind: "arrayLit",
    elems: [
      {
        kind: "unionWrap",
        unionId: "stored",
        tag: 1,
        value: { kind: "unitLit", unit: "null", type: NULL_T, loc },
        type: stored,
        loc,
      },
    ],
    type: arrayOf(stored),
    loc,
  };
  const read: IrExpr = {
    kind: "unionKeyGet",
    unionId: "arrays",
    value: { kind: "unionWrap", unionId: "arrays", tag: 0, value: array, type: receiver, loc },
    key: { kind: "numLit", value: 0, type: F64, loc },
    type: result,
    loc,
  };
  const mod = expressionModule(read, [
    { id: "stored", arms: [F64, NULL_T] },
    { id: "arrays", arms: [arrayOf(stored), arrayOf(STRING), UNDEFINED_T] },
    { id: "result", arms: [F64, NULL_T, STRING, UNDEFINED_T] },
  ]);
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  mod.unions![2]!.arms = [F64, STRING, UNDEFINED_T];
  expect(
    validateModule(mod).some((error) => error.message.includes("element union cannot surface")),
  ).toBe(true);
});

test("numeric array-read intrinsic validates and round-trips", () => {
  const mod = numericReadModule();
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
});

test("indexed equality validates primitive kinds, arguments, and result", () => {
  const args: IrExpr[] = [
    { kind: "numLit", value: 0, type: F64, loc },
    { kind: "arrayLit", elems: [], type: arrayOf(F64), loc },
    { kind: "numLit", value: 1, type: F64, loc },
  ];
  const mod = numericReadModule({ method: "indexEq", args, type: BOOL });
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  for (const override of [
    { args: [] },
    { type: F64 },
    { args: [args[0]!, { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc }, args[2]!] },
    { receiver: { kind: "arrayLit", elems: [], type: arrayOf(arrayOf(F64)), loc } },
  ] satisfies Partial<IrExpr & { kind: "arrIntrinsic" }>[]) {
    expect(
      validateModule(numericReadModule({ method: "indexEq", args, type: BOOL, ...override })),
    ).not.toEqual([]);
  }
});

test.each([
  [
    { receiver: { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc } },
    "requires f64 elements",
  ],
  [{ args: [] }, "0 args, expected 1"],
  [{ args: [{ kind: "strLit", value: "0", type: STRING, loc }] }, "arg 0: expected f64"],
  [{ type: BOOL }, "must be f64"],
] satisfies [Partial<IrExpr & { kind: "arrIntrinsic" }>, string][])(
  "numeric array-read intrinsic rejects malformed IR %#",
  (overrides, message) => {
    expect(
      validateModule(numericReadModule(overrides)).some((error) => error.message.includes(message)),
    ).toBe(true);
  },
);

function tdzModule(mutable = true): IrModule {
  const value: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        loc,
        locals: [{ id: "value", name: "value", type: F64, mutable, boxed: true, tdz: true }],
        body: [
          { kind: "varDecl", localId: "value", init: null, loc },
          { kind: "assign", localId: "value", value, initializes: true, loc },
        ],
      },
    ],
  };
}

test.each([true, false])(
  "TDZ declarations round-trip their initialization marker (mutable=%s)",
  (mutable) => {
    const mod = tdzModule(mutable);
    expect(validateModule(mod)).toEqual([]);
    expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  },
);

test("an initialization marker cannot bypass an ordinary immutable binding", () => {
  const mod = tdzModule(false);
  delete mod.functions[0]!.locals[0]!.tdz;
  const messages = validateModule(mod).map((error) => error.message);
  expect(
    messages.some((message) =>
      message.includes('initializing assign requires a TDZ binding "value"'),
    ),
  ).toBe(true);
  expect(messages.some((message) => message.includes('assign to immutable local "value"'))).toBe(
    true,
  );
});

test("global assignments cannot masquerade as lexical initialization", () => {
  const mod = tdzModule();
  mod.globals = [{ id: "value", name: "value", type: F64, mutable: true }];
  mod.functions[0]!.locals = [];
  mod.functions[0]!.body.shift();
  expect(
    validateModule(mod).some((error) =>
      error.message.includes("initializing assign requires a TDZ binding"),
    ),
  ).toBe(true);
});

test("TDZ globals require guarded pointer storage and round-trip initialization", () => {
  const mod = tdzModule();
  const type = { kind: "record", shapeId: "codec" } as const;
  mod.records = [{ id: "codec", fields: [{ name: "%TextEncoder", type: F64 }], declaredOrder: [] }];
  mod.globals = [{ id: "%g.value", name: "value", type, mutable: false, tdz: true }];
  mod.functions[0]!.locals = [];
  mod.functions[0]!.body = [
    {
      kind: "assign",
      localId: "%g.value",
      initializes: true,
      loc,
      value: {
        kind: "recordLit",
        fields: [{ name: "%TextEncoder", value: { kind: "numLit", value: -1, type: F64, loc } }],
        type,
        loc,
      },
    },
  ];
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  mod.globals[0]!.type = F64;
  expect(
    validateModule(mod).some((error) =>
      error.message.includes(
        'TDZ global "value" must have record, function, or checked-value storage',
      ),
    ),
  ).toBe(true);
});

test("legacy const TDZ declarations remain readable", () => {
  const mod = tdzModule(false);
  const store = mod.functions[0]!.body[1]!;
  if (store.kind !== "assign") throw new Error("fixture");
  delete store.initializes;
  expect(validateModule(mod)).toEqual([]);
});

test("TDZ initialization still checks the payload representation", () => {
  const mod = tdzModule();
  const store = mod.functions[0]!.body[1]!;
  if (store.kind !== "assign") throw new Error("fixture");
  store.value = { kind: "strLit", value: "wrong", type: STRING, loc };
  expect(validateModule(mod).some((error) => error.message.includes('assign "value"'))).toBe(true);
});

function overflowPresenceModule(): IrModule {
  const record: IrType = { kind: "record", shapeId: "dictionary" };
  const check: IrExpr = {
    kind: "recordOvfHas",
    shapeId: "dictionary",
    obj: { kind: "recordLit", fields: [], type: record, loc },
    key: { kind: "strLit", value: "key", type: STRING, loc },
    type: BOOL,
    loc,
  };
  const mod = expressionModule(check, []);
  mod.records = [{ id: "dictionary", fields: [], indexValue: F64 }];
  return mod;
}

test("overflow presence checks validate and serialize", () => {
  const mod = overflowPresenceModule();
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
});

test("overflow presence requires a map-bearing shape", () => {
  const mod = overflowPresenceModule();
  delete mod.records![0]!.indexValue;
  expect(
    validateModule(mod).some((error) =>
      error.message.includes("requires an index-signature record"),
    ),
  ).toBe(true);
});

test("overflow presence rejects an undeclared shape", () => {
  const mod = overflowPresenceModule();
  mod.records = [];
  expect(
    validateModule(mod).some((error) => error.message.includes("recordOvfHas on undeclared shape")),
  ).toBe(true);
});

test.each(["receiver", "key", "result"] as const)(
  "overflow presence checks its %s type",
  (slot) => {
    const mod = overflowPresenceModule();
    const statement = mod.functions[0]!.body[0]!;
    if (statement.kind !== "exprStmt" || statement.expr.kind !== "recordOvfHas")
      throw new Error("fixture");
    const check = statement.expr;
    const wrong: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
    if (slot === "receiver") check.obj = wrong;
    else if (slot === "key") check.key = wrong;
    else check.type = F64;
    const message = slot === "result" ? "recordOvfHas must be bool" : `recordOvfHas ${slot}`;
    expect(validateModule(mod).some((error) => error.message.includes(message))).toBe(true);
  },
);

function fieldPresenceModule(absentInLiteral: boolean): IrModule {
  const optional: IrType = { kind: "union", unionId: "maybeCount" };
  const record: IrType = { kind: "record", shapeId: "item" };
  const absent: IrExpr = { kind: "fieldAbsent", unionId: "maybeCount", type: optional, loc };
  const literal: IrExpr = {
    kind: "recordLit",
    fields: [
      {
        name: "count",
        value: absentInLiteral
          ? {
              kind: "ternary",
              cond: { kind: "boolLit", value: true, type: BOOL, loc },
              then: {
                kind: "unionWrap",
                unionId: "maybeCount",
                tag: 0,
                value: { kind: "numLit", value: 1, type: F64, loc },
                type: optional,
                loc,
              },
              else_: absent,
              type: optional,
              loc,
            }
          : {
              kind: "unionWrap",
              unionId: "maybeCount",
              tag: 1,
              value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
              type: optional,
              loc,
            },
      },
    ],
    type: record,
    loc,
  };
  const check: IrExpr = {
    kind: "recordHas",
    obj: literal,
    shapeId: "item",
    field: "count",
    type: BOOL,
    loc,
  };
  const mod = expressionModule(check, [{ id: "maybeCount", arms: [F64, UNDEFINED_T] }]);
  mod.records = [{ id: "item", fields: [{ name: "count", type: optional }] }];
  if (!absentInLiteral) mod.functions[0]!.body.push({ kind: "exprStmt", expr: absent, loc });
  return mod;
}

test("field presence checks and absent field states validate and serialize", () => {
  const mod = fieldPresenceModule(true);
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
});

test("the absent field state is confined to field writes", () => {
  expect(
    validateModule(fieldPresenceModule(false)).some((error) =>
      error.message.includes("fieldAbsent outside a record field write"),
    ),
  ).toBe(true);
});

test("the absent field state requires an undefined arm", () => {
  const mod = fieldPresenceModule(true);
  mod.unions = [{ id: "maybeCount", arms: [F64, STRING] }];
  expect(
    validateModule(mod).some((error) => error.message.includes("the union has no undefined arm")),
  ).toBe(true);
});

test("field presence checks name a declared field", () => {
  const mod = fieldPresenceModule(true);
  const statement = mod.functions[0]!.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "recordHas")
    throw new Error("fixture");
  statement.expr.field = "missing";
  expect(
    validateModule(mod).some((error) => error.message.includes('has no field "missing"')),
  ).toBe(true);
});

test("TDZ locals require a shared box", () => {
  const mod = tdzModule();
  delete mod.functions[0]!.locals[0]!.boxed;
  expect(
    validateModule(mod).some((error) => error.message.includes('TDZ local "value" must be boxed')),
  ).toBe(true);
});

function discriminatedModule(): IrModule {
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }],
    records: [
      { id: "empty", fields: [{ name: "kind", type: STRING }] },
      {
        id: "value",
        fields: [
          { name: "kind", type: STRING },
          { name: "value", type: F64 },
        ],
      },
    ],
    unions: [
      {
        id: "variants",
        arms: [
          NULL_T,
          { kind: "record", shapeId: "empty" },
          { kind: "record", shapeId: "value" },
          UNDEFINED_T,
        ],
        discriminant: {
          field: "kind",
          cases: [
            { tag: 1, values: ["empty"] },
            { tag: 2, values: ["number", "value"] },
          ],
        },
      },
    ],
  };
}

test("discriminator metadata validates and survives serialization", () => {
  const mod = discriminatedModule();
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
});

test.each([
  [
    "missing arm",
    (m: IrModule) => {
      m.unions![0]!.discriminant!.cases.pop();
    },
    "missing discriminant",
  ],
  [
    "unit arm",
    (m: IrModule) => {
      m.unions![0]!.discriminant!.cases[0]!.tag = 0;
    },
    "invalid discriminant tag",
  ],
  [
    "negative tag",
    (m: IrModule) => {
      m.unions![0]!.discriminant!.cases[0]!.tag = -1;
    },
    "invalid discriminant tag",
  ],
  [
    "fractional tag",
    (m: IrModule) => {
      m.unions![0]!.discriminant!.cases[0]!.tag = 1.5;
    },
    "invalid discriminant tag",
  ],
  [
    "missing field",
    (m: IrModule) => {
      m.unions![0]!.discriminant!.field = "absent";
    },
    "invalid discriminant tag",
  ],
  [
    "duplicate tag",
    (m: IrModule) => {
      m.unions![0]!.discriminant!.cases.push({ tag: 1, values: ["other"] });
    },
    "invalid discriminant tag",
  ],
  [
    "empty values",
    (m: IrModule) => {
      m.unions![0]!.discriminant!.cases[0]!.values = [];
    },
    "empty discriminant values",
  ],
  [
    "wrong primitive",
    (m: IrModule) => {
      m.unions![0]!.discriminant!.cases[0]!.values = [false];
    },
    "invalid or repeated",
  ],
  [
    "shared literal",
    (m: IrModule) => {
      m.unions![0]!.discriminant!.cases[1]!.values = ["empty"];
    },
    "invalid or repeated",
  ],
  [
    "duplicate literal",
    (m: IrModule) => {
      m.unions![0]!.discriminant!.cases[0]!.values = ["empty", "empty"];
    },
    "invalid or repeated",
  ],
] as const)("discriminator metadata rejects %s", (_name, mutate, message) => {
  const mod = discriminatedModule();
  mutate(mod);
  expect(validateModule(mod).some((error) => error.message.includes(message))).toBe(true);
});

test("numeric discriminators reject non-finite values", () => {
  const mod = discriminatedModule();
  for (const record of mod.records!) record.fields[0]!.type = F64;
  const guard = mod.unions![0]!.discriminant!;
  guard.cases[0]!.values = [0];
  guard.cases[1]!.values = [1];
  expect(validateModule(mod)).toEqual([]);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    guard.cases[1]!.values = [invalid];
    expect(validateModule(mod).some((error) => error.message.includes("invalid or repeated"))).toBe(
      true,
    );
  }
});

test("mixed literal discriminators resolve field unions declared later", () => {
  const mod = discriminatedModule();
  mod.records![1]!.fields[0]!.type = { kind: "union", unionId: "literal" };
  mod.unions![0]!.discriminant!.cases[1]!.values = ["value", 1];
  mod.unions!.push({ id: "literal", arms: [F64, STRING] });
  expect(validateModule(mod)).toEqual([]);
  mod.unions![0]!.discriminant!.cases[1]!.values.push(false);
  expect(validateModule(mod).some((error) => error.message.includes("invalid or repeated"))).toBe(
    true,
  );
});

test("typed-array brand tests serialize their element kind and reject misplaced brands", () => {
  const expr: IrExpr = {
    kind: "dynTest",
    test: "bytes",
    bytesElem: "u16",
    value: { kind: "dynObjLit", type: DYN, loc },
    type: BOOL,
    loc,
  };
  const mod = expressionModule(expr, []);
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  expr.test = "array";
  expect(validateModule(mod).map((d) => d.message)).toContain(
    "in main: dynTest bytesElem requires a valid bytes test",
  );
});

test("function result views preserve the parameter ABI and reject reversed covariance", () => {
  const source: IrType = {
    kind: "func",
    params: [F64],
    ret: { kind: "object", className: "Child" },
  };
  const target: IrType = {
    kind: "func",
    params: [F64],
    ret: { kind: "object", className: "Base" },
  };
  const mod = expressionModule(
    {
      kind: "upcast",
      value: { kind: "varRef", localId: "callback", type: source, loc },
      type: target,
      loc,
    },
    [],
  );
  mod.classes = [
    { name: "Base", fields: [], loc },
    { name: "Child", base: "Base", fields: [], loc },
    { name: "Other", fields: [], loc },
  ];
  mod.functions[0]!.params = [{ localId: "callback", name: "callback", type: source }];
  mod.functions[0]!.locals = [{ id: "callback", name: "callback", type: source, mutable: false }];
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  for (const variant of [
    "parameter",
    "arity",
    "rest",
    "rest-abi",
    "arguments",
    "return",
    "unrelated",
    "reverse",
  ] as const) {
    const bad = structuredClone(mod);
    const stmt = bad.functions[0]!.body[0]!;
    if (stmt.kind !== "exprStmt" || stmt.expr.kind !== "upcast" || stmt.expr.type.kind !== "func")
      throw new Error("fixture");
    const type = stmt.expr.type;
    if (variant === "parameter") type.params[0] = STRING;
    if (variant === "arity") type.params.push(F64);
    if (variant === "rest") type.rest = true;
    if (variant === "rest-abi") type.restAbi = "jsval";
    if (variant === "arguments") type.argumentsAll = true;
    if (variant === "return") type.ret = F64;
    if (variant === "unrelated") type.ret = { kind: "object", className: "Other" };
    if (variant === "reverse") {
      if (stmt.expr.value.type.kind !== "func") throw new Error("fixture");
      stmt.expr.value.type.ret = { kind: "object", className: "Base" };
      type.ret = { kind: "object", className: "Child" };
    }
    expect(
      validateModule(bad).map((error) => error.message),
      variant,
    ).toContain(
      "in main: function upcast requires identical parameters and a covariant class return",
    );
  }
});

test("abstract virtual slots admit subclass returns without admitting unrelated return layouts", () => {
  const mod = virtualCallModule();
  const base: IrType = { kind: "object", className: "Base" };
  const child: IrType = { kind: "object", className: "First" };
  for (const fn of mod.functions.filter((fn) => fn.name.startsWith("%"))) {
    fn.params.push({ localId: "result", name: "result", type: child });
    fn.locals.push({ id: "result", name: "result", type: child, mutable: false });
    fn.returnType = child;
    fn.body = [
      { kind: "return", value: { kind: "varRef", localId: "result", type: child, loc }, loc },
    ];
  }
  for (const fn of mod.functions.filter((fn) => fn.name.startsWith("caller"))) {
    fn.params.push({ localId: "result", name: "result", type: child });
    fn.locals.push({ id: "result", name: "result", type: child, mutable: false });
    const stmt = fn.body[0]!;
    if (stmt.kind !== "exprStmt" || stmt.expr.kind !== "virtualCall") throw new Error("fixture");
    stmt.expr.type = base;
    stmt.expr.args.push({ kind: "varRef", localId: "result", type: child, loc });
  }
  expect(validateModule(deserializeModule(serializeModule(mod)))).toEqual([]);
  mod.classes!.find((cls) => cls.name === "First")!.base = "Unrelated";
  expect(validateModule(mod).map((error) => error.message)).toEqual([
    "in caller0: virtualCall Base.run result type mismatch",
    "in caller1: virtualCall Base.run result type mismatch",
  ]);
});

test("signature adapters capture the function whose identity they share", () => {
  const source: IrType = { kind: "func", params: [F64], ret: VOID };
  const target: IrType = { kind: "func", params: [F64, F64], ret: VOID };
  const adapter: IrExpr & { kind: "closure" } = {
    kind: "closure",
    fnName: "view",
    captures: ["f.0"],
    adapts: true,
    type: target,
    loc,
  };
  const mod = expressionModule(adapter, []);
  mod.functions[0]!.locals.push({
    id: "f.0",
    name: "f",
    type: source,
    mutable: false,
    boxed: true,
  });
  mod.functions.push({
    name: "view",
    params: [
      { localId: "a.0", name: "a", type: F64 },
      { localId: "b.0", name: "b", type: F64 },
    ],
    captures: [{ localId: "f.0", name: "f", type: source }],
    locals: [
      { id: "f.0", name: "f", type: source, mutable: false, boxed: true },
      { id: "a.0", name: "a", type: F64, mutable: false },
      { id: "b.0", name: "b", type: F64, mutable: false },
    ],
    returnType: VOID,
    body: [],
    loc,
  });
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
  const numeric = structuredClone(mod);
  for (const fn of numeric.functions)
    for (const local of fn.locals) if (local.id === "f.0") local.type = F64;
  numeric.functions[1]!.captures = [{ localId: "f.0", name: "f", type: F64 }];
  expect(
    validateModule(numeric).some((error) =>
      error.message.includes("an adapter's first capture must be a function"),
    ),
  ).toBe(true);
});

test("a caught-typed global records a module error only from a catch binding", () => {
  const caught: IrType = { kind: "caught" };
  const errorId = "%g.e.%loaded%error";
  const module = (value: IrExpr): IrModule => ({
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    unions: [],
    globals: [{ id: errorId, name: "%error", type: caught, mutable: true }],
    functions: [
      {
        name: "main",
        params: [],
        locals: [{ id: "e.0", name: "e", type: caught, mutable: false }],
        returnType: VOID,
        body: [
          {
            kind: "tryCatch",
            tryBody: [],
            catchBody: [
              { kind: "assign", localId: errorId, value, loc },
              { kind: "rethrow", localId: errorId, loc },
            ],
            catchLocalId: "e.0",
            finallyBody: null,
            loc,
          },
        ],
        loc,
      },
    ],
  });
  const binding: IrExpr = { kind: "varRef", localId: "e.0", type: caught, loc };
  expect(validateModule(deserializeModule(serializeModule(module(binding))))).toEqual([]);
  const other: IrExpr = { kind: "varRef", localId: errorId, type: caught, loc };
  expect(validateModule(module(other)).map((d) => d.message)).toEqual([
    'in main: assign to catch binding "%error" (frontend must reject)',
  ]);
});
