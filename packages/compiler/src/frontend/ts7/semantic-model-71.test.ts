import { expect, test } from "vitest";
import { SemanticChecker } from "./semantic-checker.js";
import { SemanticSnapshot } from "./semantic-model.js";
import { SyntaxKind, TypeFlags } from "./enums.js";

/** A snapshot on a fake TypeScript 7.1 server: `answer` gets each request's
 * method and parsed payload and returns the reply's JSON. */
function server(answer: (method: string, query: Record<string, unknown>) => unknown) {
  const requests: { method: string; query: Record<string, unknown> }[] = [];
  const snapshot = new SemanticSnapshot(
    1,
    {
      text: (method, payload) => {
        const query = JSON.parse(payload) as Record<string, unknown>;
        requests.push({ method, query });
        return JSON.stringify(answer(method, query) ?? null);
      },
      binary(method, payload) {
        const text = this.text(method, payload);
        // AST replies (typeToTypeNode, signatureToSignatureDeclaration) are empty for none.
        return text === "null" ? new Uint8Array() : Buffer.from(text, "utf8");
      },
    },
    true,
  );
  const project = snapshot.addProject("project", () => undefined);
  return { snapshot, project, checker: new SemanticChecker(project), requests };
}

const file = {
  fileName: "/main.ts",
  path: "/main.ts",
  contentHash: "0",
  parseOptionsKey: "0",
  scriptKind: 3,
  nodeId: "77",
};

test("TypeScript 7.1 symbol references round-trip through local ids", () => {
  const box = { kind: 0, file, id: 1 };
  const parent = { kind: 0, file, id: 2 };
  const { project, checker, requests } = server((method, query) => {
    if (method === "getTypeAtPosition")
      return { id: 10, flags: TypeFlags.Object, objectFlags: 1, symbol: { id: 1, file: "77" } };
    if (method === "getSymbolOfType")
      return {
        reference: box,
        name: "Box",
        flags: 32,
        checkFlags: 0,
        parent: { id: 2, file: "77" },
      };
    if (method === "getParentOfSymbol") {
      expect(query["symbol"]).toEqual(box);
      expect(query["objectId"]).toBeUndefined();
      return { reference: parent, name: '"/main"', flags: 512, checkFlags: 0 };
    }
    if (method === "getDeclaredTypeOfSymbol") {
      expect(query["symbol"]).toEqual(box);
      return { id: 11, flags: TypeFlags.Object, isTupleType: true };
    }
    if (method === "getExportsOfModule") {
      expect(query["symbol"]).toEqual(parent);
      return [{ reference: box, name: "Box", flags: 32, checkFlags: 0 }];
    }
    throw new Error(`unexpected ${method}`);
  });
  const type = checker.getTypeAtPosition("/main.ts", 0)!;
  const symbol = type.getSymbol()!;
  expect(symbol.escapedName).toBe("Box");
  // The compact reference in the type and the full one in the symbol name one symbol.
  expect(project.snapshot.cachedSymbol(symbol.id)).toBe(symbol);
  const owner = symbol.getParent()!;
  expect(owner.escapedName).toBe('"/main"');
  expect(checker.getExportsOfModule(owner)).toEqual([symbol]);
  const declared = checker.getDeclaredTypeOfSymbol(symbol);
  expect(checker.isTupleType(declared)).toBe(true);
  expect(checker.isTupleType(type)).toBe(false);
  expect(requests.map((request) => request.method)).not.toContain("isTupleType");
});

test("TypeScript 7.1 requests name types and signatures as 7.1 does", () => {
  const { project, checker, requests } = server((method) => {
    if (method === "getApparentType" || method === "getReturnTypeOfSignature")
      return { id: 12, flags: TypeFlags.Number };
    if (method === "signatureToSignatureDeclaration") return null;
    if (method === "getWellKnownSymbols") return { unknown: 5, undefined: 6, arguments: 7 };
    if (method === "getSymbolAtPosition")
      return {
        reference: { kind: 1, snapshot: 1, project: "project", id: 6 },
        name: "undefined",
        flags: 3,
        checkFlags: 0,
      };
    throw new Error(`unexpected ${method}`);
  });
  const type = project.type({ id: 1, flags: TypeFlags.Object });
  const signature = project.signature({ id: 3, flags: 0 });
  checker.getApparentType(type);
  checker.getReturnTypeOfSignature(signature);
  checker.signatureToSignatureDeclaration(signature, SyntaxKind.FunctionType);
  const queries = new Map(requests.map((request) => [request.method, request.query]));
  expect(queries.get("getApparentType")).toMatchObject({ objectId: 1 });
  expect(queries.get("getApparentType")!["type"]).toBeUndefined();
  expect(queries.get("getReturnTypeOfSignature")).toMatchObject({ objectId: 3 });
  // 7.1 numbers every kind from SourceKeyword up one higher.
  expect(queries.get("signatureToSignatureDeclaration")).toMatchObject({
    kind: SyntaxKind.FunctionType + 1,
  });
  // A well-known symbol id names a symbol of the snapshot.
  const undefinedSymbol = checker.getSymbolAtPosition("/main.ts", 0)!;
  expect(checker.isUndefinedSymbol(undefinedSymbol)).toBe(true);
  expect(checker.isUnknownSymbol(undefinedSymbol)).toBe(false);
});

test("TypeScript 7.1 constant values are read from their answer object", () => {
  const answers = [
    { isNumber: true, value: 1 },
    { isNumber: false, value: "a" },
    { isNumber: true, value: "+Infinity" },
    { isNumber: true, value: "-Infinity" },
    { isNumber: true, value: "NaN" },
    null,
  ];
  let next = 0;
  const { checker } = server((method) => {
    expect(method).toBe("getConstantValue");
    return answers[next++];
  });
  const node = { id: "2.306./main.ts" } as Parameters<typeof checker.getConstantValue>[0];
  expect(checker.getConstantValue(node)).toBe(1);
  expect(checker.getConstantValue(node)).toBe("a");
  expect(checker.getConstantValue(node)).toBe(Infinity);
  expect(checker.getConstantValue(node)).toBe(-Infinity);
  expect(checker.getConstantValue(node)).toBeNaN();
  expect(checker.getConstantValue(node)).toBeUndefined();
});
