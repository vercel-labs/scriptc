import {
  BOOL,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  arrayOf,
  funcOf,
  mapOf,
  type IrClassDef,
  type IrFunction,
  type IrModule,
  type IrType,
} from "../../packages/compiler/src/ir/ir.js";
import { IR_VERSION } from "../../packages/compiler/src/ir/serialize.js";

export interface EmissionRequest {
  bits: 32 | 64;
  clones: string[];
  classObjects: string[];
  sources: { file: string; text: string }[];
  writers?: IrType[];
  joinUnions?: string[];
  indent?: boolean;
}
export interface EmissionCase {
  name: string;
  module: IrModule;
  request: EmissionRequest;
  contains: string[];
}

const loc = { file: "native layouts/日本.ts", start: 0, end: 12 };
const obj = (name: string): IrType => ({ kind: "object", className: name });
const rec = (id: string): IrType => ({ kind: "record", shapeId: id });
const optional: IrType = { kind: "union", unionId: "optional" };

export function emissionRequest(bits: 32 | 64 = 64): EmissionRequest {
  return { bits, clones: [], classObjects: [], sources: [] };
}

export function emissionModule(): IrModule {
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }],
  };
}

function method(name: string, member: string, result: IrType = F64): IrFunction {
  return {
    name: `%${name}.${member}`,
    params: [{ localId: "this.0", name: "this", type: obj(name) }],
    locals: [{ id: "this.0", name: "this", type: obj(name), mutable: false }],
    returnType: result,
    body: [],
    loc,
  };
}

function cls(name: string, base?: string): IrClassDef {
  return { name, ...(base ? { base } : {}), fields: [{ name: "value", type: F64 }], loc };
}

export function emissionCases(): EmissionCase[] {
  const cases: EmissionCase[] = [];
  const add = (
    name: string,
    module: IrModule,
    contains: string[],
    request = emissionRequest(),
  ): void => {
    cases.push({ name, module, contains, request });
  };
  add("empty module", emissionModule(), []);

  const scalar = emissionModule();
  scalar.records = [
    {
      id: "scalar",
      fields: [
        { name: "enabled", type: BOOL },
        { name: "value", type: F64 },
      ],
    },
  ];
  add("scalar record allocation", scalar, [
    "type { i64, i8, double }",
    "@scr_rt_calloc",
    "@scr_rt_free",
  ]);

  const refs = emissionModule();
  refs.records = [
    {
      id: "references",
      fields: [
        { name: "text", type: STRING },
        { name: "values", type: arrayOf(F64) },
        { name: "index", type: mapOf(STRING, F64) },
        { name: "bytes", type: { kind: "bytes", elem: "u8" } },
      ],
    },
  ];
  add("reference fields", refs, [
    "@scr_str_release",
    "@scr_arr_release",
    "@scr_map_release",
    "@scr_bytes_release",
  ]);

  const recursive = emissionModule();
  recursive.records = [
    {
      id: "node",
      fields: [
        { name: "children", type: arrayOf(rec("node")) },
        { name: "text", type: STRING },
      ],
    },
  ];
  // The free path is width-specific (64-bit emission inlines the allocator
  // and pushes the block onto its free list; 32-bit calls scr_cyc_free), so
  // only the shared allocation and collector entry points are asserted.
  add("recursive records", recursive, ["@scr_cyc_alloc", "@scr_cyc_on_dead", "@scr_arr_trace"]);

  // Constructor-only edges are proven acyclic (cycle-analysis.ts): a record
  // whose only self reference goes through a nullable union field skips
  // the collector. An array edge is always mutable, so adding one closes a
  // collectable cycle through the same union.
  const acyclicUnion = emissionModule();
  acyclicUnion.records = [{ id: "linked", fields: [{ name: "next", type: optional }] }];
  acyclicUnion.unions = [{ id: "optional", arms: [rec("linked"), UNDEFINED_T] }];
  // `linked | undefined` is a nullable pointer: the field releases through
  // the record's NULL-tolerant helper, with no union box.
  add("constructor-only nullable union edge", acyclicUnion, [
    "@scr_rt_calloc",
    "@sc_rrelease_linked",
  ]);

  const union = emissionModule();
  union.records = [
    {
      id: "linked",
      fields: [
        { name: "next", type: optional },
        { name: "peers", type: arrayOf(optional) },
      ],
    },
  ];
  union.unions = [{ id: "optional", arms: [rec("linked"), UNDEFINED_T] }];
  add("cycles through a nullable union", union, ["@scr_cyc_alloc", "@sc_rrelease_linked"]);

  // A second non-unit arm keeps the union a tagged box.
  const boxedUnion = emissionModule();
  boxedUnion.records = [
    {
      id: "linked",
      fields: [
        { name: "next", type: optional },
        { name: "peers", type: arrayOf(optional) },
      ],
    },
  ];
  boxedUnion.unions = [{ id: "optional", arms: [rec("linked"), STRING, UNDEFINED_T] }];
  add("cycles through a boxed union", boxedUnion, ["@scr_union_trace", "@scr_union_release"]);

  const overflow = emissionModule();
  overflow.records = [
    { id: "dictionary", fields: [{ name: "label", type: STRING }], indexValue: rec("dictionary") },
  ];
  add("overflow-map cycles", overflow, ["[key: string]", "@scr_map_trace", "@scr_map_release"]);

  const tuple = emissionModule();
  tuple.records = [
    {
      id: "tuple",
      tuple: true,
      fields: [
        { name: "0", type: STRING },
        { name: "1", type: F64 },
      ],
    },
  ];
  add("tuple layout", tuple, ["type { i64, ptr, double }"]);

  const wide = emissionModule();
  wide.records = [
    {
      id: "wide",
      fields: Array.from({ length: 18 }, (_, i) => ({ name: `f${i}`, type: i % 2 ? STRING : F64 })),
    },
  ];
  const clones = emissionRequest();
  clones.clones = ["wide"];
  add("wide record clone", wide, ["clone", "@scr_str_retain"], clones);

  const small = emissionModule();
  small.records = [{ id: "small", fields: [{ name: "value", type: F64 }] }];
  const smallClones = emissionRequest();
  smallClones.clones = ["small"];
  add("inline clone threshold", small, ["type { i64, double }"], smallClones);

  const exotic = emissionModule();
  exotic.records = [{ id: "unicode😀", fields: [{ name: "break\nline\0*/é", type: STRING }] }];
  add("source text escaping", exotic, ["break\\u000aline\\u0000*/é", "_xd83d__xde00_"]);

  const standalone = emissionModule();
  standalone.classes = [cls("Alone")];
  add("standalone class", standalone, ["; class Alone { value }", "@sc_new_Alone"]);

  const hierarchy = emissionModule();
  const root = cls("Base");
  root.methods = ["read"];
  const child = cls("Child", "Base");
  child.methods = ["read"];
  child.fields.push({ name: "label", type: STRING });
  hierarchy.classes = [root, child];
  hierarchy.functions.push(method("Base", "read"), method("Child", "read"));
  add("virtual dispatch and inherited fields", hierarchy, [
    "vtable: hierarchy rooted at Base [read]",
    "@sc_reld_Child",
    "dispatches",
  ]);

  const forest = structuredClone(hierarchy);
  forest.classes!.push(cls("Unrelated"), cls("Leaf", "Child"));
  forest.classes![3]!.fields = [...child.fields];
  add("class forest numbering", forest, ["class Leaf (vt at 1)", "class Unrelated { value }"]);

  const abstract = emissionModule();
  const abstractRoot = cls("Abstract");
  abstractRoot.abstract = true;
  abstractRoot.methods = ["read"];
  abstractRoot.abstractMethods = ["read"];
  const concrete = cls("Concrete", "Abstract");
  concrete.methods = ["read"];
  abstract.classes = [abstractRoot, concrete];
  abstract.functions.push(method("Concrete", "read"));
  add("abstract slot implementation", abstract, ["ptr null", "@sc_f__x25_Concrete_read"]);

  const incomplete = emissionModule();
  const abstractChild = cls("AbstractChild", "Abstract");
  abstractChild.abstract = true;
  incomplete.classes = [structuredClone(abstractRoot), abstractChild];
  add("abstract hierarchy without implementation", incomplete, [
    "vtable: hierarchy rooted at Abstract",
  ]);

  const siblingSlots = emissionModule();
  const left = cls("Left", "Root");
  left.methods = ["read"];
  const leftLeaf = cls("LeftLeaf", "Left");
  leftLeaf.methods = ["read"];
  const right = cls("Right", "Root");
  right.methods = ["read"];
  const rightLeaf = cls("RightLeaf", "Right");
  rightLeaf.methods = ["read"];
  siblingSlots.classes = [cls("Root"), left, leftLeaf, right, rightLeaf];
  for (const name of ["Left", "LeftLeaf", "Right", "RightLeaf"])
    siblingSlots.functions.push(method(name, "read"));
  add("same method name in sibling subtrees", siblingSlots, ["[read, read]"]);

  // The array edge is mutable, so the First/Second cycle stays collectable
  // (constructor-only references alone are proven acyclic).
  const classCycle = emissionModule();
  classCycle.classes = [
    {
      name: "First",
      fields: [
        { name: "other", type: obj("Second") },
        { name: "peers", type: arrayOf(obj("Second")) },
      ],
      loc,
    },
    { name: "Second", fields: [{ name: "other", type: obj("First") }], loc },
  ];
  add("mutually recursive classes", classCycle, [
    "@sc_trace_First",
    "@sc_trace_Second",
    "@scr_cyc_alloc",
  ]);

  const nullable = emissionModule();
  nullable.unions = [{ id: "optional", arms: [mapOf(STRING, F64), UNDEFINED_T] }];
  nullable.classes = [{ name: "Options", fields: [{ name: "map", type: optional }], loc }];
  add("undefined field initialization", nullable, ["@native_unit_0", "starts undefined"]);

  const dynField = emissionModule();
  dynField.classes = [
    { name: "Island", fields: [{ name: "value", type: { kind: "jsval" } }], loc },
  ];
  add("island field initialization", dynField, ["@scr_jsval_undefined", "@scr_jsval_release"]);

  const emitter = emissionModule();
  emitter.classes = [
    { name: "%EventEmitter", runtime: true, fields: [], loc },
    { name: "Emitter", base: "%EventEmitter", fields: [], loc },
  ];
  add("event emitter prefix", emitter, [
    "ScrEmitter prefix at 2",
    "@scr_emitter_reg_drop",
    "@native_string_0",
  ]);

  const stream = emissionModule();
  stream.classes = [
    { name: "%EventEmitter", runtime: true, fields: [], loc },
    { name: "%Readable", runtime: true, base: "%EventEmitter", fields: [], loc },
    { name: "Reader", base: "%Readable", fields: [], loc },
  ];
  add("stream prefix", stream, [
    "ScrStream prefix at 2",
    "@scr_stream_st_release",
    "@scr_stream_st_trace",
  ]);

  const construct = emissionModule();
  construct.classes = [cls("Construct")];
  const ctor = method("Construct", "constructor", VOID);
  ctor.params.push(
    { localId: "n.0", name: "n", type: F64 },
    { localId: "s.0", name: "s", type: STRING },
    { localId: "b.0", name: "b", type: BOOL },
  );
  construct.functions.push(ctor);
  const constructRequest = emissionRequest();
  constructRequest.classObjects = ["Construct"];
  add(
    "constructor thunk ABI",
    construct,
    ["double %a0, ptr %a1, i1 %a2", "%ScrClassObj"],
    constructRequest,
  );

  const generic = structuredClone(construct);
  generic.classes = [cls("Family"), { ...cls("Construct", "Family"), genericOf: "Family" }];
  add(
    "generic class object family interval",
    generic,
    ["construct thunk Construct", "vtable: hierarchy rooted at Family"],
    constructRequest,
  );

  const captured = emissionModule();
  captured.records = [{ id: "closure", fields: [{ name: "fn", type: funcOf([], VOID) }] }];
  add("closure cycles", captured, ["@scr_closure_trace_v", "@scr_closure_release"]);

  const writer = structuredClone(recursive);
  const writerRequest = emissionRequest();
  writerRequest.writers = [rec("node"), arrayOf(rec("node")), F64, BOOL, STRING, rec("node")];
  writerRequest.indent = true;
  add(
    "recursive JSON writers and indentation",
    writer,
    ["@scr_jb_enter", "@scr_jb_put_f64"],
    writerRequest,
  );

  const tupleRequest = emissionRequest();
  tupleRequest.writers = [rec("tuple")];
  add("tuple JSON writer", tuple, ["@scr_jb_putc"], tupleRequest);
  const dictionaryRequest = emissionRequest();
  dictionaryRequest.writers = [rec("dictionary")];
  add("overflow JSON writer", overflow, ["@scr_map_keys_js_order"], dictionaryRequest);
  const textUnion = emissionModule();
  textUnion.unions = [{ id: "text", arms: [BOOL, F64, STRING, { kind: "nullT" }, UNDEFINED_T] }];
  const textRequest = emissionRequest();
  textRequest.writers = [{ kind: "union", unionId: "text" }];
  textRequest.joinUnions = ["text", "text"];
  add(
    "union JSON and direct join helpers",
    textUnion,
    ["switch i32", "@scr_arr_peek_ref", "@scr_jb_put_number"],
    textRequest,
  );

  const debug = emissionModule();
  const debugText =
    "function example(value: number) {\r\n  const outer = 1;\n  { const inner = 2; }\n}\n";
  const scope = { file: loc.file, start: 0, end: debugText.length };
  const innerScope = {
    file: loc.file,
    start: debugText.indexOf("{ const"),
    end: debugText.indexOf("; }") + 3,
  };
  const position = (name: string) => ({
    file: loc.file,
    start: debugText.indexOf(name),
    end: debugText.indexOf(name) + name.length,
  });
  debug.functions[0]!.loc = scope;
  debug.functions[0]!.params = [{ localId: "value.0", name: "value", type: F64 }];
  debug.functions[0]!.locals = [
    {
      id: "value.0",
      name: "value",
      type: F64,
      mutable: false,
      source: { loc: position("value"), scope },
    },
    {
      id: "outer.0",
      name: "outer",
      type: STRING,
      mutable: true,
      boxed: true,
      source: { loc: position("outer"), scope },
    },
    {
      id: "inner.0",
      name: "inner",
      type: F64,
      mutable: true,
      boxed: true,
      tdz: true,
      source: { loc: position("inner"), scope: innerScope },
    },
  ];
  debug.functions[0]!.body = [{ kind: "return", value: null, loc: position("inner") }];
  debug.globals = [
    {
      id: "global",
      name: "global",
      type: BOOL,
      mutable: false,
      source: { loc: position("outer"), scope },
    },
  ];
  const debugRequest = emissionRequest();
  debugRequest.sources = [{ file: loc.file, text: debugText }];
  add(
    "debug bindings and nested scopes",
    debug,
    ["DILexicalBlock", 'name: "ScrBox"', 'name: "value", arg: 1'],
    debugRequest,
  );

  // Every layout case also exercises the actual wasm32 size_t and cycle
  // header offsets. The textual result must match the Node production stage.
  return cases.flatMap((item) => [
    item,
    {
      ...item,
      name: item.name + " (32-bit)",
      request: { ...item.request, bits: 32 as const },
      contains: item.contains.map((text) => text.replaceAll("i64", "i32")),
    },
  ]);
}
