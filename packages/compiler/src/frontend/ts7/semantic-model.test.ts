import { describe, expect, test } from "vitest";
import type { SymbolResponse, TypeResponse } from "typescript/unstable/proto";
import {
  isBigIntLiteralType,
  isBooleanLiteralType,
  isClassOrInterfaceType,
  isConditionalType,
  isErrorType,
  isIndexType,
  isIndexedAccessType,
  isIntersectionType,
  isIntrinsicType,
  isLiteralType,
  isNumberLiteralType,
  isObjectType,
  isStringLiteralType,
  isStringMappingType,
  isSubstitutionType,
  isTemplateLiteralType,
  isTupleType,
  isTypeParameter,
  isTypeReference,
  isUnionType,
  type Type,
} from "typescript/unstable/sync";
import {
  SemanticNodeHandle,
  SemanticSnapshot,
  SemanticType,
  symbolNameOf,
  escapedSymbolName,
} from "./semantic-model.js";
import type { __String } from "./ast-types.js";
import {
  SemanticObjectFlags as ObjectFlags,
  SemanticSignatureFlags as SignatureFlags,
  SemanticTypeFlags as TypeFlags,
} from "./semantic-schema.generated.js";

function harness() {
  const requests: { method: string; query: Record<string, unknown> }[] = [];
  const answers = new Map<string, unknown>();
  const snapshot = new SemanticSnapshot(17, {
    text(method, payload) {
      requests.push({ method, query: JSON.parse(payload) });
      if (!answers.has(method)) throw new Error(`Unexpected request ${method}`);
      return JSON.stringify(answers.get(method));
    },
    // Object replies are read as bytes; they carry the same JSON.
    binary(method, payload) {
      return Buffer.from(this.text(method, payload), "utf8");
    },
  });
  const first = snapshot.addProject("/first.json", () => undefined);
  const second = snapshot.addProject("/second.json", () => undefined);
  const symbol = (id: number, extra: Partial<SymbolResponse> = {}): SymbolResponse =>
    ({
      id,
      flags: 2,
      checkFlags: 0,
      name: `name${id}`,
      project: first.id,
      ...extra,
    }) as SymbolResponse;
  return { snapshot, first, second, requests, answers, symbol };
}

test("types/signatures are project-local and symbols are snapshot-wide", () => {
  const { snapshot, first, second, symbol } = harness();
  const data = { id: 1, flags: TypeFlags.Number };
  expect(first.type(data)).toBe(first.type({ ...data }));
  expect(second.type(data)).not.toBe(first.type(data));
  expect(first.signature({ id: 1, flags: 0 })).toBe(first.signature({ id: 1, flags: 0 }));
  expect(second.signature({ id: 1, flags: 0 })).not.toBe(first.signature({ id: 1, flags: 0 }));
  expect(second.symbol(symbol(1))).toBe(first.symbol(symbol(1)));
  expect(second.symbol(symbol(1)).canonicalProject).toBe(first);
  const separate = new SemanticSnapshot(snapshot.id, snapshot.transport);
  const third = separate.addProject(first.id, () => undefined);
  expect(third.symbol(symbol(1))).not.toBe(first.symbol(symbol(1)));
  expect(third.type(data)).not.toBe(first.type(data));
});

test("canonical projects must exist before a symbol is registered", () => {
  const { first, symbol, snapshot } = harness();
  const missing = symbol(2, { project: "/later.json" as SymbolResponse["project"] });
  expect(() => first.symbol(missing)).toThrow("Unknown TypeScript canonical project");
  const later = snapshot.addProject("/later.json", () => undefined);
  expect(first.symbol(missing).canonicalProject).toBe(later);
  expect(() => snapshot.addProject(later.id, () => undefined)).toThrow(
    "Duplicate TypeScript project",
  );
});

test("absent handles and empty known lists do not issue requests", () => {
  const { first, requests, symbol } = harness();
  const type = first.type({ id: 1, flags: TypeFlags.Number });
  expect(type.getSymbol()).toBeUndefined();
  expect(type.getAliasSymbol()).toBeUndefined();
  expect(type.getTarget()).toBeUndefined();
  expect(type.getFreshType()).toBeUndefined();
  expect(type.getRegularType()).toBeUndefined();
  expect(type.getObjectType()).toBeUndefined();
  expect(type.getIndexType()).toBeUndefined();
  expect(type.getCheckType()).toBeUndefined();
  expect(type.getExtendsType()).toBeUndefined();
  expect(type.getBaseType()).toBeUndefined();
  expect(type.getConstraint()).toBeUndefined();
  expect(type.getTypes()).toEqual([]);
  expect(type.getBaseTypes()).toBeUndefined();
  expect(type.getTypeParameters()).toEqual([]);
  expect(type.getOuterTypeParameters()).toEqual([]);
  expect(type.getLocalTypeParameters()).toEqual([]);
  expect(type.getAliasTypeArguments()).toEqual([]);
  const signature = first.signature({ id: 1, flags: 0 });
  expect(signature.getTypeParameters()).toEqual([]);
  expect(signature.getParameters()).toEqual([]);
  expect(signature.getThisParameter()).toBeUndefined();
  expect(signature.getTarget()).toBeUndefined();
  const sym = first.symbol(symbol(1));
  expect(sym.getParent()).toBeUndefined();
  expect(sym.getExportSymbol()).toBe(sym);
  expect(requests).toEqual([]);
});

describe("lazy type handles", () => {
  const cases = [
    ["symbol", "getSymbolOfType", "getSymbol"],
    ["aliasSymbol", "getAliasSymbolOfType", "getAliasSymbol"],
    ["target", "getTargetOfType", "getTarget"],
    ["freshType", "getFreshTypeOfType", "getFreshType"],
    ["regularType", "getRegularTypeOfType", "getRegularType"],
    ["objectType", "getObjectTypeOfType", "getObjectType"],
    ["indexType", "getIndexTypeOfType", "getIndexType"],
    ["checkType", "getCheckTypeOfType", "getCheckType"],
    ["extendsType", "getExtendsTypeOfType", "getExtendsType"],
    ["baseType", "getBaseTypeOfType", "getBaseType"],
    ["substConstraint", "getConstraintOfType", "getConstraint"],
  ] as const;
  for (const [field, method, accessor] of cases) {
    test(`${accessor} resolves once and reuses the correct identity registry`, () => {
      const { first, second, answers, requests, symbol } = harness();
      const isSymbol = field === "symbol" || field === "aliasSymbol";
      const data = isSymbol ? symbol(2) : { id: 2, flags: TypeFlags.String };
      answers.set(method, data);
      const type = first.type({ id: 1, flags: 0, [field]: 2 });
      const result = type[accessor]();
      expect(type[accessor]()).toBe(result);
      expect(requests).toEqual([
        { method, query: { snapshot: 17, project: first.id, objectId: 1 } },
      ]);
      expect(result).toBe(
        isSymbol ? second.symbol(data as SymbolResponse) : first.type(data as TypeResponse),
      );
      if (!isSymbol) expect(second.type(data as TypeResponse)).not.toBe(result);
    });
  }
});

test("a partially cached type list fetches once, preserves order and duplicates", () => {
  const { first, answers, requests } = harness();
  const one = first.type({ id: 1, flags: TypeFlags.String });
  const two = { id: 2, flags: TypeFlags.Number };
  const data = { id: 3, flags: TypeFlags.Object, typeParameters: [2, 1, 2] };
  answers.set("getTypeParametersOfType", [two, { id: one.id, flags: one.flags }, two]);
  const type = first.type(data);
  const parameters = type.getTypeParameters();
  expect(parameters).toEqual([first.type(two), one, first.type(two)]);
  expect(type.getTypeParameters()).toEqual(parameters);
  expect(requests).toHaveLength(1);
});

test("unknown constituent lists fetch while non-constituent types stay local", () => {
  const { first, answers, requests } = harness();
  answers.set("getTypesOfType", [{ id: 2, flags: TypeFlags.String }]);
  for (const flags of [TypeFlags.Union, TypeFlags.Intersection, TypeFlags.TemplateLiteral]) {
    const type = first.type({ id: flags, flags });
    expect(type.getTypes()?.[0]).toBe(first.type({ id: 2, flags: TypeFlags.String }));
  }
  expect(requests).toHaveLength(3);
});

test("constituent caches preserve order, duplicates, empty results and project-local identity", () => {
  const { first, second, answers, requests } = harness();
  const data = [
    { id: 2, flags: TypeFlags.Number },
    { id: 3, flags: TypeFlags.String },
    { id: 2, flags: TypeFlags.Number },
  ];
  answers.set("getTypesOfType", data);
  for (const flags of [TypeFlags.Union, TypeFlags.Intersection, TypeFlags.TemplateLiteral]) {
    const a = first.type({ id: flags, flags });
    const b = second.type({ id: flags, flags });
    const items = a.getTypes()!;
    const others = b.getTypes()!;
    expect(a.getTypes()).toBe(items);
    expect(b.getTypes()).toBe(others);
    expect(items[0]).toBe(items[2]);
    expect(others[0]).toBe(others[2]);
    expect(items[0]).not.toBe(others[0]);
    expect(items.map((type) => type.flags)).toEqual([
      TypeFlags.Number,
      TypeFlags.String,
      TypeFlags.Number,
    ]);
  }
  expect(requests).toHaveLength(6);
  answers.set("getTypesOfType", []);
  const empty = first.type({ id: 100, flags: TypeFlags.Union });
  const list = empty.getTypes();
  expect(list).toEqual([]);
  expect(empty.getTypes()).toBe(list);
  expect(requests).toHaveLength(7);
});

test("constituent fetch failures remain retryable and never install partial answers", () => {
  const { first, answers, requests } = harness();
  const type = first.type({ id: 1, flags: TypeFlags.Union });
  expect(() => type.getTypes()).toThrow("Unexpected request");
  answers.set("getTypesOfType", [{ id: 2, flags: TypeFlags.String }]);
  const result = type.getTypes()!;
  expect(result[0]).toBe(first.type({ id: 2, flags: TypeFlags.String }));
  expect(type.getTypes()).toBe(result);
  expect(requests).toHaveLength(2);
});

test("warm constituent reads check disposal before returning a cached list", () => {
  const { first, second, snapshot, answers, requests } = harness();
  answers.set("getTypesOfType", [{ id: 2, flags: TypeFlags.Number }]);
  const firstType = first.type({ id: 1, flags: TypeFlags.Union });
  const secondType = second.type({ id: 1, flags: TypeFlags.Union });
  firstType.getTypes();
  const secondList = secondType.getTypes();
  first.dispose();
  expect(() => firstType.getTypes()).toThrow("disposed");
  expect(secondType.getTypes()).toBe(secondList);
  snapshot.dispose();
  expect(() => secondType.getTypes()).toThrow("disposed");
  expect(requests).toHaveLength(2);
});

test("project cleanup runs once, after invalidation, including reentrant disposal", () => {
  const { first, second, snapshot } = harness();
  const calls: string[] = [];
  first.onDispose(() => {
    calls.push("first");
    expect(() => first.ensureActive()).toThrow("disposed");
    expect(() => first.onDispose(() => {})).toThrow("disposed");
    first.dispose();
  });
  first.onDispose(() => calls.push("first again"));
  second.onDispose(() => calls.push("second"));
  first.dispose();
  first.dispose();
  expect(calls).toEqual(["first", "first again"]);
  second.ensureActive();
  snapshot.dispose();
  snapshot.dispose();
  expect(calls).toEqual(["first", "first again", "second"]);
});

test("snapshot disposal releases populated symbol tables even when callers retain the symbols", () => {
  const { first, snapshot, symbol, answers } = harness();
  const parent = first.symbol(symbol(1));
  answers.set("getMembersOfSymbol", [symbol(2)]);
  answers.set("getExportsOfSymbol", [symbol(3)]);
  const members = parent.getMembers();
  const exports = parent.getExports();
  expect(members.size).toBe(1);
  expect(exports.size).toBe(1);
  snapshot.dispose();
  expect(members.size).toBe(0);
  expect(exports.size).toBe(0);
  expect(() => parent.getMembers()).toThrow("disposed");
  expect(() => parent.getExports()).toThrow("disposed");
});

test("conditional branches have independent lazy state, including a retry after refusal", () => {
  const { first, answers, requests } = harness();
  const type = first.type({ id: 3, flags: TypeFlags.Conditional });
  answers.set("getTrueTypeOfConditionalType", null);
  expect(() => type.getTrueType()).toThrow("returned null type");
  answers.set("getTrueTypeOfConditionalType", { id: 1, flags: TypeFlags.String });
  answers.set("getFalseTypeOfConditionalType", { id: 2, flags: TypeFlags.Number });
  const yes = type.getTrueType();
  const no = type.getFalseType();
  expect(yes).not.toBe(no);
  expect(type.getTrueType()).toBe(yes);
  expect(type.getFalseType()).toBe(no);
  expect(requests.map((request) => request.method)).toEqual([
    "getTrueTypeOfConditionalType",
    "getTrueTypeOfConditionalType",
    "getFalseTypeOfConditionalType",
  ]);
});

test("base types use the checker type field, not an objectId request", () => {
  const { first, answers, requests } = harness();
  const type = first.type({ id: 1, flags: TypeFlags.Object, objectFlags: ObjectFlags.Interface });
  answers.set("getBaseTypes", [{ id: 2, flags: TypeFlags.Object, objectFlags: ObjectFlags.Class }]);
  expect(type.getBaseTypes()?.[0]?.isClassOrInterface()).toBe(true);
  expect(requests).toEqual([
    { method: "getBaseTypes", query: { snapshot: 17, project: first.id, type: 1 } },
  ]);
});

test("symbol tables keep escaped keys, display names, canonical context and cache identity", () => {
  const { first, second, answers, requests, symbol } = harness();
  const parent = second.symbol(symbol(1, { parent: 2, exportSymbol: 3 }));
  answers.set("getMembersOfSymbol", [symbol(4, { name: "___x" as SymbolResponse["name"] })]);
  answers.set("getExportsOfSymbol", [symbol(5, { name: "__x" as SymbolResponse["name"] })]);
  answers.set("getParentOfSymbol", symbol(2));
  answers.set("getExportSymbolOfSymbol", symbol(3));
  const members = parent.getMembers();
  const exports = parent.getExports();
  expect(symbolNameOf(members.get("___x" as __String))).toBe("__x");
  expect(symbolNameOf(exports.get("__x" as __String))).toBe("__x");
  // A name that starts with `__` is keyed with an extra `_`.
  expect(symbolNameOf(members.get(escapedSymbolName("__x")))).toBe("__x");
  expect(escapedSymbolName("x")).toBe("x");
  expect(escapedSymbolName("_x")).toBe("_x");
  expect(escapedSymbolName("___y")).toBe("____y");
  expect(parent.getMembers()).toBe(members);
  expect(parent.getExports()).toBe(exports);
  expect(parent.getParent()).toBe(first.symbol(symbol(2)));
  expect(parent.getExportSymbol()).toBe(first.symbol(symbol(3)));
  expect(requests.every((request) => request.query["project"] === first.id)).toBe(true);
  expect(requests).toHaveLength(4);
});

test("signature handles use type, symbol and signature registries independently", () => {
  const { first, answers, requests, symbol } = harness();
  const signature = first.signature({
    id: 1,
    flags: SignatureFlags.HasRestParameter | SignatureFlags.Construct | SignatureFlags.Abstract,
    typeParameters: [2],
    parameters: [2, 3],
    thisParameter: 3,
    target: 2,
  });
  answers.set("getTypeParametersOfSignature", [{ id: 2, flags: TypeFlags.TypeParameter }]);
  answers.set("getParametersOfSignature", [symbol(2), symbol(3)]);
  answers.set("getTargetOfSignature", { id: 2, flags: 0 });
  expect(signature.getTypeParameters()[0]?.isTypeParameter()).toBe(true);
  const parameters = signature.getParameters();
  expect(signature.getThisParameter()).toBe(parameters[1]);
  expect(signature.getParameters()).toEqual(parameters);
  expect(signature.getTypeParameters()[0]).toBe(
    first.type({ id: 2, flags: TypeFlags.TypeParameter }),
  );
  expect(signature.getTarget()).toBe(first.signature({ id: 2, flags: 0 }));
  expect(signature.getTarget()).not.toBe(signature);
  expect(signature.hasRestParameter && signature.isConstruct && signature.isAbstract).toBe(true);
  expect(requests).toHaveLength(3);
});

test("literal metadata preserves zero, false, empty strings and arbitrary precision integers", () => {
  const { first } = harness();
  const values = [
    { flags: TypeFlags.StringLiteral, input: "", expected: "" },
    { flags: TypeFlags.NumberLiteral, input: 0, expected: 0 },
    { flags: TypeFlags.BooleanLiteral, input: false, expected: false },
    {
      flags: TypeFlags.BigIntLiteral,
      input: "-123456789012345678901234567890",
      expected: -123456789012345678901234567890n,
    },
  ];
  for (const [index, { flags, input, expected }] of values.entries()) {
    expect(first.type({ id: index + 1, flags, value: input }).value).toBe(expected);
  }
  expect(first.type({ id: 6, flags: TypeFlags.String, value: null }).value).toBeUndefined();
});

test("native semantic predicates match all pinned TypeScript flag classifications", () => {
  const { first } = harness();
  const predicates = [
    ["isUnionType", isUnionType],
    ["isIntersectionType", isIntersectionType],
    ["isObjectType", isObjectType],
    ["isClassOrInterface", isClassOrInterfaceType],
    ["isIntrinsicType", isIntrinsicType],
    ["isErrorType", isErrorType],
    ["isLiteralType", isLiteralType],
    ["isStringLiteralType", isStringLiteralType],
    ["isNumberLiteralType", isNumberLiteralType],
    ["isBigIntLiteralType", isBigIntLiteralType],
    ["isBooleanLiteralType", isBooleanLiteralType],
    ["isTypeReference", isTypeReference],
    ["isTupleType", isTupleType],
    ["isIndexType", isIndexType],
    ["isIndexedAccessType", isIndexedAccessType],
    ["isConditionalType", isConditionalType],
    ["isSubstitutionType", isSubstitutionType],
    ["isTemplateLiteralType", isTemplateLiteralType],
    ["isStringMappingType", isStringMappingType],
    ["isTypeParameter", isTypeParameter],
  ] as const;
  let id = 0;
  for (const flags of Object.values(TypeFlags))
    for (const objectFlags of [
      0,
      ObjectFlags.Class,
      ObjectFlags.Interface,
      ObjectFlags.Reference,
      ObjectFlags.Tuple,
    ]) {
      const type = first.type({ id: ++id, flags, objectFlags, intrinsicName: "error" });
      for (const [name, oracle] of predicates)
        expect(type[name](), `${name} flags=${flags} objectFlags=${objectFlags}`).toBe(
          oracle(type as unknown as Type),
        );
    }
});

test("project disposal cannot poison another project, and snapshot disposal seals every cache", () => {
  const { snapshot, first, second, symbol, requests } = harness();
  const old = first.type({ id: 1, flags: TypeFlags.Number });
  const shared = first.symbol(symbol(1));
  first.dispose();
  first.dispose();
  expect(() => old.getTarget()).toThrow("project is disposed");
  expect(() => first.type({ id: 1, flags: TypeFlags.Number })).toThrow("project is disposed");
  expect(second.type({ id: 1, flags: TypeFlags.String })).toBeInstanceOf(SemanticType);
  expect(second.symbol(symbol(1))).toBe(shared);
  snapshot.dispose();
  snapshot.dispose();
  expect(() => second.type({ id: 1, flags: TypeFlags.Number })).toThrow("snapshot is disposed");
  expect(() => shared.getMembers()).toThrow("snapshot is disposed");
  expect(() => snapshot.addProject("later", () => undefined)).toThrow("snapshot is disposed");
  expect(requests).toEqual([]);
});

test("node handles validate their serialized identity and retain canonical context", () => {
  const { first } = harness();
  const handle = new SemanticNodeHandle("7.79./file.with.dots.ts", first);
  expect([handle.index, handle.kind, handle.path]).toEqual([7, 79, "/file.with.dots.ts"]);
  expect(handle.resolve()).toBeUndefined();
  expect(() => new SemanticNodeHandle("bad", first)).toThrow();
  first.dispose();
  expect(() => handle.resolve()).toThrow("disposed");
});
