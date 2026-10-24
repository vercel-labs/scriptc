import { expect, test } from "vitest";
import { exprFunctionReference, moduleFunctionReferences } from "./function-references.js";
import { functionCallFacts } from "./int32-slots.js";
import {
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "./ir.js";
import { everyStmtList } from "./traverse.js";

/* Every plain `string` field of the IR, classified. The analyses that ask
 * which functions escape (constant-callbacks.ts, int32-slots.ts) read only
 * the fields classified "reference" here, through function-references.ts.
 * A new string field anywhere in the IR fails to compile until it is
 * classified, and a new "reference" fails the tests below until the shared
 * helpers report it. */
type Role =
  /** Names a module function as a value or a runtime entry. */
  | "reference"
  /** A direct call's callee. */
  | "callee"
  /** A class method name: the function is `%<class>.<method>`. */
  | "method"
  /** A verified contract fact about a function, not a way to reach it. */
  | "fact"
  /** Never a module function's name. */
  | "other";

type Leaf = IrExpr | IrStmt | IrType | SrcLoc;
type PathsOf<V, P extends string> = V extends string
  ? string extends V
    ? P
    : never
  : V extends readonly (infer E)[]
    ? PathsOf<E, `${P}[]`>
    : V extends Leaf
      ? never
      : V extends object
        ? StringFields<V, `${P}.`>
        : never;
type StringFields<T, P extends string = ""> = {
  [K in keyof T & string]-?: PathsOf<NonNullable<T[K]>, `${P}${K}`>;
}[keyof T & string];
type Classified<U extends { kind: string }> = {
  [K in U["kind"] as [StringFields<Extract<U, { kind: K }>>] extends [never] ? never : K]: Record<
    StringFields<Extract<U, { kind: K }>>,
    Role
  >;
};

const EXPR_FIELDS: Classified<IrExpr> = {
  numLit: { spelling: "other" },
  strLit: { value: "other" },
  moduleNsRef: { moduleId: "other" },
  varRef: { localId: "other" },
  incDec: { localId: "other" },
  fieldIncDec: { className: "other", field: "other" },
  assignExpr: { localId: "other" },
  orDefault: { retag: "reference" },
  optChain: { id: "other" },
  chainRecv: { id: "other" },
  regexLit: { pattern: "other", flags: "other" },
  templateStrings: { key: "other", "cooked[]": "other" },
  call: { callee: "callee" },
  ffiCall: { import: "other" },
  closure: { fnName: "reference", "captures[]": "other" },
  new: { className: "other" },
  classRef: { className: "other", "captures[]": "other" },
  instanceOf: { className: "other" },
  virtualCall: { className: "other", method: "method", "targets[]": "other" },
  fieldGet: { className: "other", field: "other" },
  recordLit: { "fields[].name": "other" },
  recordClone: { "overrides[].name": "other" },
  recordGet: { shapeId: "other", field: "other" },
  recordKeyGet: { shapeId: "other" },
  dynFrom: { fnName: "other" },
  dynCall: { calleeName: "other", "spreads[].what": "other" },
  dynInvoke: { method: "other", calleeName: "other" },
  dynHasKey: { key: "other" },
  dynDestrCheck: { spelling: "other", firstProp: "other" },
  dynIterN: { notIterableMessage: "other" },
  recordOvfKeys: { shapeId: "other" },
  recordOvfHas: { shapeId: "other" },
  recordNullProto: { shapeId: "other" },
  recordHas: { shapeId: "other", field: "other" },
  fieldAbsent: { unionId: "other" },
  unionWrap: { unionId: "other" },
  unionRetype: { unionId: "other", fromId: "other" },
  unionFuncEq: { unionId: "other" },
  caughtTest: { className: "other" },
  caughtCheck: { className: "other" },
  unionNarrow: { unionId: "other" },
  unionDisc: { unionId: "other", field: "other" },
  unionKeyGet: { unionId: "other" },
  unionIsTag: { unionId: "other" },
  unionEq: { unionId: "other" },
  jsonStringify: { indent: "other" },
};

const STMT_FIELDS: Classified<IrStmt> = {
  varDecl: { localId: "other" },
  assign: { localId: "other" },
  while: { "labels[]": "other" },
  doWhile: { "labels[]": "other" },
  switch: { "labels[]": "other" },
  for: { "labels[]": "other" },
  forOf: { localId: "other", "labels[]": "other" },
  fieldSet: { className: "other", field: "other" },
  recordSet: { shapeId: "other", field: "other" },
  recordKeySet: { shapeId: "other" },
  recordKeyDelete: { shapeId: "other" },
  break: { label: "other" },
  continue: { label: "other" },
  block: { "labels[]": "other" },
  runtimeFence: { code: "other", message: "other" },
  rethrow: { localId: "other" },
  tryCatch: { catchLocalId: "other" },
};

const TYPE_FIELDS: Classified<IrType> = {
  object: { className: "other" },
  record: { shapeId: "other" },
  classval: { className: "other" },
  moduleNs: { moduleId: "other" },
  union: { unionId: "other" },
};

const FUNCTION_FIELDS: Record<StringFields<Omit<IrFunction, "body">>, Role> = {
  name: "other",
  sourceName: "other",
  asyncCacheGlobal: "other",
  asyncCycleCacheGlobal: "other",
  "params[].name": "other",
  "params[].localId": "other",
  "locals[].name": "other",
  "locals[].id": "other",
  "captures[].name": "other",
  "captures[].localId": "other",
  "classCaptures[].name": "other",
  "classCaptures[].localId": "other",
  "generator.tag": "other",
};

const MODULE_FIELDS: Record<StringFields<Omit<IrModule, "functions">>, Role> = {
  sourceFile: "other",
  entry: "reference",
  "classes[].name": "other",
  "classes[].base": "other",
  "classes[].jsName": "other",
  "classes[].genericOf": "other",
  "classes[].baseValueGlobal": "other",
  "classes[].errorNameAfter": "other",
  "classes[].prototypeDataHelper": "reference",
  "classes[].instancePrototypeHelper": "reference",
  "classes[].stringTagHelper": "reference",
  "classes[].localCaptures[].name": "other",
  "classes[].localCaptures[].localId": "other",
  "classes[].symbolFields[].field": "other",
  "classes[].symbolFields[].globalId": "other",
  "classes[].symbolFields[].wellKnown": "other",
  "classes[].fields[].name": "other",
  "classes[].methods[]": "method",
  "classes[].prototypeNames[]": "other",
  "classes[].abstractMethods[]": "method",
  "globals[].id": "other",
  "globals[].name": "other",
  "globals[].initFlag": "other",
  "records[].id": "other",
  "records[].fields[].name": "other",
  "records[].declaredOrder[]": "other",
  "records[].accessorOrder[]": "other",
  "records[].orderVariants[][]": "other",
  "unions[].id": "other",
  "unions[].discriminant.field": "other",
  "unions[].discriminant.cases[].values[]": "other",
  "ffiImports[].name": "other",
  "ffiImports[].symbol": "other",
  "ffiImports[].library": "other",
  "ffiImports[].callbackTarget": "other",
  "ffiImports[].params[].context": "other",
  "ffiImports[].params[].callback.id": "other",
  "ffiImports[].params[].callback.release": "other",
  "ffiImports[].params[].callback.params[].context": "other",
  "lib.profileName": "other",
  "lib.prefix": "other",
  "lib.initSymbol": "other",
  "lib.sinkRegisterSymbol": "other",
  "lib.collectSymbol": "other",
  "lib.resultResetSymbol": "other",
  "lib.callbackRegisterSymbol": "other",
  "lib.callbacks[].name": "other",
  "lib.callbacks[].unregisteredTrap": "other",
  "lib.exports[].symbol": "other",
  "lib.exports[].fnName": "reference",
  "lib.exports[].inboundBytesTrap": "other",
  "lib.exports[].inboundIntTrap": "other",
  "lib.exports[].inboundCstringTrap": "other",
  "lib.trapOverlays[].code": "other",
  "lib.trapOverlays[].teaching": "other",
  "lib.trapOverlays[].remediation": "other",
  "lib.identity.buildIdSymbol": "other",
  "lib.identity.abiVersionSymbol": "other",
  "lib.identity.buildId": "other",
  "contracts.int32Fields[]": "other",
  "contracts.int32Params[]": "other",
  "contracts.int32Returns[]": "fact",
  "contracts.int32Locals[]": "other",
  "contracts.int32Elements[]": "other",
  "int32ArrayCandidates[]": "other",
  "contracts.noThrow[]": "fact",
  "contracts.acyclic[]": "other",
  "contracts.immortalGlobals[]": "other",
  "contracts.programLifetime[]": "other",
  "wasmModules[].sha256": "other",
  "wasmModules[].bytes": "other",
  "wasmUntranslated[].sha256": "other",
  "wasmUntranslated[].reason": "other",
  "threadSlotKeys[]": "other",
  "foreignElementKeys[]": "other",
  "freezableArrays[]": "other",
};

const loc = { file: "references.ts", start: 0, end: 0 };
const TARGET = "%m0.target";
const target: IrFunction = {
  name: TARGET,
  params: [{ localId: "n", name: "n", type: F64 }],
  locals: [{ id: "n", name: "n", type: F64, mutable: true }],
  returnType: VOID,
  body: [],
  loc,
};
const entry = (body: IrStmt[] = []): IrFunction => ({
  name: "%main",
  params: [],
  locals: [],
  returnType: VOID,
  body,
  loc,
});
const module = (body: IrStmt[] = []): IrModule => ({
  irVersion: 17,
  sourceFile: loc.file,
  entry: "%main",
  functions: [target, entry(body)],
});
const exprStmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });

/** A module whose only mention of TARGET, other than its definition, is
 * through the given reference field. */
const REFERENCE_FIXTURES: Record<string, () => IrModule> = {
  "closure.fnName": () =>
    module([
      exprStmt({
        kind: "closure",
        fnName: TARGET,
        captures: [],
        type: { kind: "func", params: [F64], ret: VOID },
        loc,
      }),
    ]),
  "orDefault.retag": () =>
    module([
      exprStmt({
        kind: "orDefault",
        left: { kind: "numLit", value: 0, type: F64, loc },
        right: { kind: "numLit", value: 1, type: F64, loc },
        retag: TARGET,
        type: F64,
        loc,
      }),
    ]),
  entry: () => ({ ...module(), entry: TARGET }),
  "classes[].prototypeDataHelper": () => ({
    ...module(),
    classes: [{ name: "%m0.Cell", fields: [], prototypeDataHelper: TARGET, loc }],
  }),
  "classes[].instancePrototypeHelper": () => ({
    ...module(),
    classes: [{ name: "%m0.Cell", fields: [], instancePrototypeHelper: TARGET, loc }],
  }),
  "classes[].stringTagHelper": () => ({
    ...module(),
    classes: [{ name: "%m0.Cell", fields: [], stringTagHelper: TARGET, loc }],
  }),
  "lib.exports[].fnName": () => ({
    ...module(),
    lib: {
      profileName: "references",
      prefix: "ref_",
      initSymbol: "ref_init",
      sinkRegisterSymbol: "ref_sink",
      collectSymbol: null,
      resultResetSymbol: null,
      threadInstances: false,
      exports: [{ symbol: "ref_target", fnName: TARGET, params: ["f64"], returns: "void" }],
      trapOverlays: [],
    },
  }),
};

function referencesOf(mod: IrModule): Set<string> {
  const names = new Set(moduleFunctionReferences(mod));
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      expr: (expr) => {
        const name = exprFunctionReference(expr);
        if (name !== undefined) names.add(name);
        return true;
      },
      stmt: () => true,
    });
  return names;
}

const referencePaths = (table: object, prefix: string): string[] =>
  Object.entries(table).flatMap(([key, value]) =>
    typeof value === "string"
      ? value === "reference"
        ? [prefix + key]
        : []
      : referencePaths(value as object, `${key}.`),
  );

test("every IR field that can name a function has a reference fixture", () => {
  const references = [
    ...referencePaths(EXPR_FIELDS, ""),
    ...referencePaths(STMT_FIELDS, ""),
    ...referencePaths(TYPE_FIELDS, ""),
    ...referencePaths(FUNCTION_FIELDS, "functions[]."),
    ...referencePaths(MODULE_FIELDS, ""),
  ];
  expect(references.sort()).toEqual(Object.keys(REFERENCE_FIXTURES).sort());
});

test.each(Object.keys(REFERENCE_FIXTURES))("%s escapes its function", (path) => {
  const mod = REFERENCE_FIXTURES[path]!();
  expect(referencesOf(mod).has(TARGET)).toBe(true);
  const facts = functionCallFacts(mod, new Map(), (name) => [name]);
  expect(facts.valueEscaped.has(TARGET)).toBe(true);
});

test("direct calls and look-alike strings do not escape a function", () => {
  const mod = module([
    exprStmt({ kind: "call", callee: TARGET, args: [], type: VOID, loc }),
    exprStmt({ kind: "strLit", value: TARGET, type: { kind: "string" }, loc }),
    exprStmt({
      kind: "dynFrom",
      value: { kind: "numLit", value: 0, type: F64, loc },
      fnName: TARGET,
      type: { kind: "dyn" },
      loc,
    }),
  ]);
  expect(referencesOf(mod).has(TARGET)).toBe(false);
  expect(functionCallFacts(mod, new Map(), (name) => [name]).valueEscaped.has(TARGET)).toBe(false);
});
