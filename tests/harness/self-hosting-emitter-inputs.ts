import {
  BOOL,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  arrayOf,
  mapOf,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../packages/compiler/src/ir/ir.js";
import { boolLit, numLit, strLit, varRef } from "../../packages/compiler/src/ir/build.js";
import { IR_VERSION } from "../../packages/compiler/src/ir/serialize.js";

export interface EmitterInputCase {
  name: string;
  module: IrModule;
  sources: { file: string; text: string }[];
}

const loc = { file: "native emitter/日本.ts", start: 0, end: 1 };
const record = (shapeId: string): IrType => ({ kind: "record", shapeId });
const object = (className: string): IrType => ({ kind: "object", className });
const union = (unionId: string): IrType => ({ kind: "union", unionId });

function module(): IrModule {
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }],
  };
}

function effect(expr: IrExpr): IrStmt {
  return { kind: "exprStmt", expr, loc: expr.loc };
}

function method(cls: string, member: string): IrFunction {
  return {
    name: `%${cls}.${member}`,
    params: [{ localId: "this", name: "this", type: object(cls) }],
    locals: [{ id: "this", name: "this", type: object(cls), mutable: false }],
    returnType: VOID,
    body: [],
    loc,
  };
}

/** Small, hand-built inputs cover code-generation branches that ordinary
 * TypeScript sources cannot request independently (unused layouts, exact
 * library ABI metadata, module compression and literal interning). The
 * execution cases in the harness separately check emitted program behavior. */
export function emitterInputCases(): EmitterInputCase[] {
  const cases: EmitterInputCase[] = [];
  const add = (
    name: string,
    mod: IrModule,
    sources: EmitterInputCase["sources"] = [],
  ): EmitterInputCase => {
    const item = { name, module: mod, sources };
    cases.push(item);
    return item;
  };
  add("empty executable", module());

  const strings = module();
  strings.functions[0]!.body = [
    effect(strLit('quote" slash\\ newline\n tab\t nul\u0000 end', loc)),
    effect(strLit("日本 π 😀 \ud800", loc)),
    effect(strLit("trigraph??/comment*/", loc)),
    effect(strLit("repeat", loc)),
    effect(strLit("repeat", loc)),
  ];
  add("literal escaping and interning", strings);

  const numbers = module();
  numbers.functions[0]!.body = [
    -0,
    0,
    1,
    -1,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    Infinity,
    -Infinity,
  ].map((value) => effect(numLit(value, loc)));
  numbers.functions[0]!.body.push(
    effect({ kind: "bin", op: "/", left: numLit(0, loc), right: numLit(0, loc), type: F64, loc }),
  );
  add("floating point constants", numbers);

  const source = module();
  source.functions[0]!.body = [effect(strLit("line two", { ...loc, start: 12, end: 20 }))];
  add("source locations with multibyte text", source, [
    { file: loc.file, text: "// 日本\nconsole.log('line two');\n" },
  ]);

  const records = module();
  records.records = [
    {
      id: "scalar",
      fields: [
        { name: "flag", type: BOOL },
        { name: "value", type: F64 },
      ],
    },
    {
      id: "references",
      fields: [
        { name: "list", type: arrayOf(STRING) },
        { name: "text", type: STRING },
      ],
    },
    {
      id: "tuple",
      tuple: true,
      fields: [
        { name: "0", type: STRING },
        { name: "1", type: F64 },
      ],
    },
  ];
  add("scalar, reference and tuple layouts", records);

  const recursive = module();
  recursive.records = [
    {
      id: "node",
      fields: [
        { name: "children", type: arrayOf(record("node")) },
        { name: "text", type: STRING },
      ],
    },
  ];
  add("recursive record trace and teardown", recursive);

  const mutual = module();
  mutual.records = [
    { id: "left", fields: [{ name: "next", type: union("rightMaybe") }] },
    { id: "right", fields: [{ name: "next", type: union("leftMaybe") }] },
  ];
  mutual.unions = [
    { id: "rightMaybe", arms: [record("right"), UNDEFINED_T] },
    { id: "leftMaybe", arms: [record("left"), UNDEFINED_T] },
  ];
  add("mutually recursive optional records", mutual);

  const overflow = module();
  overflow.records = [
    {
      id: "dictionary",
      fields: [{ name: "label", type: STRING }],
      indexValue: record("dictionary"),
    },
  ];
  add("recursive overflow maps", overflow);

  const cls = (name: string, base?: string): IrClassDef => ({
    name,
    ...(base === undefined ? {} : { base }),
    fields: [{ name: "label", type: STRING }],
    methods: ["visit"],
    loc,
  });
  const classes = module();
  classes.classes = [cls("Root"), cls("Left", "Root"), cls("Right", "Root"), cls("Leaf", "Left")];
  for (const c of classes.classes) classes.functions.push(method(c.name, "visit"));
  add("class forest and virtual dispatch tables", classes);

  const abstract = module();
  abstract.classes = [
    { ...cls("Abstract"), abstract: true, abstractMethods: ["visit"] },
    cls("Concrete", "Abstract"),
  ];
  abstract.functions.push(method("Concrete", "visit"));
  add("abstract method ABI from descendant", abstract);

  const globals = module();
  globals.globals = [
    { id: "%g.text", name: "text", type: STRING, mutable: true },
    { id: "%g.values", name: "values", type: arrayOf(F64), mutable: true },
  ];
  globals.functions[0]!.body = [
    { kind: "assign", localId: "%g.text", value: strLit("global", loc), loc },
    {
      kind: "assign",
      localId: "%g.values",
      value: { kind: "arrayLit", elems: [numLit(1, loc)], type: arrayOf(F64), loc },
      loc,
    },
  ];
  add("global initialization and shutdown ownership", globals);

  const constantTable = module();
  constantTable.globals = [{ id: "%g.table", name: "table", type: arrayOf(F64), mutable: false }];
  constantTable.functions[0]!.body = [
    {
      kind: "assign",
      localId: "%g.table",
      value: {
        kind: "arrayLit",
        elems: [1, 4, 9, 16].map((n) => numLit(n, loc)),
        type: arrayOf(F64),
        loc,
      },
      loc,
    },
    effect({
      kind: "arrayGet",
      arr: varRef("%g.table", arrayOf(F64), loc),
      index: numLit(2, loc),
      type: F64,
      loc,
    }),
  ];
  add("constant numeric array storage", constantTable);

  const labels = module();
  labels.functions[0]!.body = [
    {
      kind: "block",
      labels: ["outer"],
      body: [
        {
          kind: "switch",
          disc: boolLit(true, loc),
          labels: ["choose"],
          cases: [
            { test: boolLit(false, loc), body: [effect(strLit("skipped", loc))] },
            { test: null, body: [{ kind: "break", label: "outer", loc }] },
          ],
          loc,
        },
      ],
      loc,
    },
  ];
  add("switch and block jump labels", labels);

  const closure = module();
  const closureType: IrType = { kind: "func", params: [], ret: STRING };
  closure.functions.push({
    name: "reader",
    params: [],
    locals: [{ id: "message", name: "message", type: STRING, mutable: true, boxed: true }],
    returnType: STRING,
    captures: [{ localId: "message", name: "message", type: STRING }],
    body: [{ kind: "return", value: varRef("message", STRING, loc), loc }],
    loc,
  });
  closure.functions[0]!.locals = [
    { id: "message", name: "message", type: STRING, mutable: true, boxed: true },
  ];
  closure.functions[0]!.body = [
    { kind: "varDecl", localId: "message", init: strLit("capture", loc), loc },
    effect({ kind: "closure", fnName: "reader", captures: ["message"], type: closureType, loc }),
  ];
  add("closure capture boxes", closure);

  const invocation = module();
  invocation.functions.push(closure.functions[1]!);
  invocation.functions[0]!.locals = closure.functions[0]!.locals;
  invocation.functions[0]!.body = [
    closure.functions[0]!.body[0]!,
    effect({
      kind: "callValue",
      callee: { kind: "closure", fnName: "reader", captures: ["message"], type: closureType, loc },
      args: [],
      type: STRING,
      loc,
    }),
  ];
  add("synchronous callback environment", invocation);

  const unions = module();
  unions.unions = [{ id: "scalar", arms: [BOOL, F64, STRING, UNDEFINED_T] }];
  unions.functions[0]!.body = [
    effect({
      kind: "unionWrap",
      unionId: "scalar",
      tag: 2,
      value: strLit("payload", loc),
      type: union("scalar"),
      loc,
    }),
    effect({
      kind: "unionWrap",
      unionId: "scalar",
      tag: 3,
      value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
      type: union("scalar"),
      loc,
    }),
  ];
  add("union scalar payloads and immortal units", unions);

  const dictionary = module();
  const mapType = mapOf(STRING, F64);
  dictionary.functions[0]!.body = [effect({ kind: "mapNew", type: mapType, loc })];
  add("typed map construction", dictionary);

  const shortNpm = module();
  shortNpm.embedded = {
    modules: [
      { key: "/node_modules/tiny/index.js", format: "esm", source: "export const n = 1;" },
      { key: "/node_modules/tiny/config.json", format: "json", source: '{"name":"π"}' },
      { key: "/node_modules/tiny/empty.js", format: "cjs", source: "", esm: "export default {};" },
    ],
    edges: [
      {
        from: "/node_modules/tiny/index.js",
        specifier: "./config.json",
        to: "/node_modules/tiny/config.json",
        kind: "import",
      },
      { from: "/node_modules/tiny/index.js", specifier: "node:path", to: "node:path", kind: "any" },
    ],
  };
  add("uncompressed npm, JSON and CJS facade tables", shortNpm);

  const compressed = module();
  compressed.embedded = {
    modules: [
      {
        key: "/node_modules/large/index.js",
        format: "cjs",
        source: "exports.value = 'repeat π';\n".repeat(2000),
        esm: "export const value = 'repeat π';\n".repeat(2000),
      },
    ],
    edges: [
      {
        from: "/app/main.js",
        specifier: "large",
        to: "/node_modules/large/index.js",
        kind: "require",
      },
      {
        from: "/app/main.js",
        specifier: "large",
        to: "/node_modules/large/index.js",
        kind: "import",
      },
    ],
  };
  add("level-nine module and facade compression", compressed);

  const chunked = module();
  // A deterministic byte distribution prevents this source from being a
  // single repeated run while forcing several source-literal chunks.
  let state = 1;
  let text = "";
  for (let i = 0; i < 12_000; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    text += String.fromCharCode(32 + (state % 95));
  }
  chunked.embedded = {
    modules: [
      { key: "/node_modules/random/data.json", format: "json", source: JSON.stringify(text) },
    ],
    edges: [],
  };
  add("large source literal chunk boundaries", chunked);

  const library = module();
  library.lib = {
    profileName: "native-test",
    prefix: "native_",
    initSymbol: "native_init",
    sinkRegisterSymbol: "native_sink",
    collectSymbol: "native_collect",
    resultResetSymbol: "native_reset",
    threadInstances: false,
    exports: [],
    trapOverlays: [],
    identity: {
      buildIdSymbol: "native_build_id",
      abiVersionSymbol: "native_abi",
      buildId: "0123456789abcdef",
      abiVersion: 7,
    },
  };
  add("library entry points and identity constants", library);

  const threaded = module();
  threaded.lib = { ...library.lib, threadInstances: true };
  threaded.globals = [{ id: "%g.counter", name: "counter", type: F64, mutable: true }];
  threaded.functions[0]!.body = [
    { kind: "assign", localId: "%g.counter", value: numLit(0, loc), loc },
  ];
  add("thread-local library globals", threaded);
  return cases;
}
