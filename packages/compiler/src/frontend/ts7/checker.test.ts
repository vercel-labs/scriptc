import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CheckerFacade, constituentTypes } from "./checker.js";
import { Ts7RpcClient } from "./rpc-client.js";
import { registerTs7FileSystem, TS7_FILE_SYSTEM_CALLBACKS } from "./rpc-filesystem.js";
import { spawnTs7Wire } from "./rpc-process.js";
import { ts7Executable } from "./rpc-api.js";
import { Ts7Session } from "./session.js";
import { SemanticChecker } from "./semantic-checker.js";
import { SemanticSnapshot } from "./semantic-model.js";
import { TypeFlags } from "./enums.js";
import { createProgram, Ts7Host } from "./program-adapter.js";
import type { AstNode } from "./ast-node.js";
import type { SourceFile } from "./ast-types.js";

const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const protocolPath = (path: string) => path.replaceAll("\\", "/");

function connect(files: Record<string, string>) {
  const dir = mkdtempSync(join(tempRoot, "scriptc-checker-lifetime-"));
  const paths = new Map(
    Object.entries(files).map(([name, text]) => [protocolPath(join(dir, name)), text]),
  );
  const rpc = new Ts7RpcClient(
    spawnTs7Wire(ts7Executable(), [
      "--api",
      "--cwd",
      dir,
      `--callbacks=${TS7_FILE_SYSTEM_CALLBACKS}`,
    ]),
  );
  registerTs7FileSystem(rpc, {
    readFile: (path) => paths.get(path),
    fileExists: (path) => (paths.has(path) ? true : undefined),
    directoryExists: () => undefined,
    realpath: () => undefined,
    getAccessibleEntries: () => undefined,
  });
  const session = new Ts7Session(rpc);
  return {
    session,
    rpc,
    paths,
    path: (name: string) => protocolPath(join(dir, name)),
    close: () => {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function declaration(root: SourceFile, name: string): AstNode {
  for (const statement of root.statements) {
    if (statement.name?.text === name) return statement;
    for (const node of statement.declarationList?.declarations ?? [])
      if (node.name?.text === name) return node;
  }
  throw new Error(`Missing declaration ${name}`);
}

const config = JSON.stringify({
  compilerOptions: { strict: true, target: "esnext", types: [] },
  files: ["main.ts"],
});

test("unchanged AST identities receive independent semantic answers after a dependency update", () => {
  const h = connect({
    "tsconfig.json": config,
    "main.ts": 'import { value } from "./dependency.js"; export const result = value;',
    "dependency.ts": "export const value: number = 1;",
  });
  try {
    const first = h.session.updateSnapshot({ openProjects: [h.path("tsconfig.json")] });
    const oldProject = first.getProjects()[0]!;
    const root = oldProject.program.getSourceFile(h.path("main.ts"))!;
    const name = declaration(root, "result").name!;
    const old = new CheckerFacade(oldProject.checker, { project: oldProject.checker.project });
    const oldType = old.getTypeAtLocation(name);
    const oldSymbol = old.getSymbolAtLocation(name)!;
    expect(old.typeToString(oldType)).toBe("number");
    expect(old.valueDeclarationOf(oldSymbol)).toBe(declaration(root, "result"));

    h.paths.set(h.path("dependency.ts"), 'export const value: string = "changed";');
    const second = h.session.updateSnapshot({
      fileChanges: { changed: [h.path("dependency.ts")] },
    });
    const newProject = second.getProjects()[0]!;
    const nextRoot = newProject.program.getSourceFile(h.path("main.ts"))!;
    expect(nextRoot).toBe(root);
    expect(declaration(nextRoot, "result").name).toBe(name);
    const next = new CheckerFacade(newProject.checker, { project: newProject.checker.project });
    const newType = next.getTypeAtLocation(name);
    expect(next.typeToString(newType)).toBe("string");
    expect(newType).not.toBe(oldType);
    expect(next.getSymbolAtLocation(name)).not.toBe(oldSymbol);
    expect(old.typeToString(old.getTypeAtLocation(name))).toBe("number");
    first.dispose();
    expect(() => old.getTypeAtLocation(name)).toThrow("disposed");
    expect(next.getTypeAtLocation(name)).toBe(newType);
    expect(next.typeToString(newType)).toBe("string");
    second.dispose();
    expect(() => next.getTypeAtLocation(name)).toThrow("disposed");
  } finally {
    h.close();
  }
});

test("project-local type handles never alias across simultaneous checker caches", () => {
  const h = connect({
    "first.json": config,
    "second.json": config,
    "main.ts": "export type Choice = string | number; export const value = 42;",
  });
  try {
    const snapshot = h.session.updateSnapshot({
      openProjects: [h.path("first.json"), h.path("second.json")],
    });
    const first = snapshot.getProject(h.path("first.json"))!;
    const second = snapshot.getProject(h.path("second.json"))!;
    const root = first.program.getSourceFile(h.path("main.ts"))!;
    expect(second.program.getSourceFile(h.path("main.ts"))).toBe(root);
    const a = new CheckerFacade(first.checker, { project: first.checker.project });
    const b = new CheckerFacade(second.checker, { project: second.checker.project });
    const name = declaration(root, "value").name!;
    const firstType = a.getTypeAtLocation(name);
    const secondType = b.getTypeAtLocation(name);
    expect(firstType.project).not.toBe(secondType.project);
    expect(firstType).not.toBe(secondType);
    expect(a.typeToString(firstType)).toBe(b.typeToString(secondType));
    const alias = declaration(root, "Choice").type!;
    const firstArms = constituentTypes(a.getTypeFromTypeNode(alias));
    const secondArms = constituentTypes(b.getTypeFromTypeNode(alias));
    expect(firstArms).not.toBe(secondArms);
    expect(firstArms.map((arm) => a.typeToString(arm))).toEqual(
      secondArms.map((arm) => b.typeToString(arm)),
    );
    first.checker.project.dispose();
    expect(() => a.getTypeAtLocation(name)).toThrow("disposed");
    expect(b.getTypeAtLocation(name)).toBe(secondType);
    expect(b.getTypeFromTypeNode(alias).getTypes()).toBe(secondArms);
  } finally {
    h.close();
  }
});

test("all public query and prefetch entry points reject a disposed facade before returning cached or local answers", () => {
  const h = connect({
    "tsconfig.json": config,
    "main.ts": "export const value = 42; export function fn(v: number): number { return v; }",
  });
  try {
    const snapshot = h.session.updateSnapshot({ openProjects: [h.path("tsconfig.json")] });
    const project = snapshot.getProjects()[0]!;
    const root = project.program.getSourceFile(h.path("main.ts"))!;
    const facade = new CheckerFacade(project.checker, { project: project.checker.project });
    const name = declaration(root, "value").name!;
    const fn = declaration(root, "fn");
    const type = facade.getTypeAtLocation(name);
    const symbol = facade.getSymbolAtLocation(name)!;
    const signature = facade.getSignatureFromDeclaration(fn)!;
    const never = project.checker.getNeverType();
    facade.getUnknownType();
    facade.typeToString(type);
    facade.prefetchSourceFile(root);
    const calls: Record<string, () => unknown> = {
      declarationsOf: () => facade.declarationsOf(symbol),
      valueDeclarationOf: () => facade.valueDeclarationOf(symbol),
      signatureDeclaration: () => facade.signatureDeclaration(signature),
      getCallSignatures: () => facade.getCallSignatures(type),
      getConstructSignatures: () => facade.getConstructSignatures(type),
      getPropertyOfType: () => facade.getPropertyOfType(type, "missing"),
      prefetchSourceFile: () => facade.prefetchSourceFile(root),
      prefetchSourceFileStructures: () => facade.prefetchSourceFileStructures([]),
      prefetchRoots: () => facade.prefetchRoots([]),
      prefetchSymbolRoots: () => facade.prefetchSymbolRoots([]),
      prefetchSymbolNodesExact: () => facade.prefetchSymbolNodesExact([]),
      prefetchCollectionTypes: () => facade.prefetchCollectionTypes([]),
      prefetchClassCollection: () => facade.prefetchClassCollection([], []),
      getTypeAtLocation: () => facade.getTypeAtLocation(name),
      getSymbolAtLocation: () => facade.getSymbolAtLocation(name),
      getTypeOfSymbol: () => facade.getTypeOfSymbol(symbol),
      prefetchMemberTypes: () => facade.prefetchMemberTypes([symbol], 0),
      getAliasedSymbol: () => facade.getAliasedSymbol(symbol),
      getDeclaredTypeOfSymbol: () => facade.getDeclaredTypeOfSymbol(symbol),
      getContextualType: () => facade.getContextualType(name),
      getTypeFromTypeNode: () => facade.getTypeFromTypeNode(fn.type!),
      getShorthandAssignmentValueSymbol: () => facade.getShorthandAssignmentValueSymbol(name),
      getResolvedSignature: () => facade.getResolvedSignature(name),
      getSignatureFromDeclaration: () => facade.getSignatureFromDeclaration(fn),
      getReturnTypeOfSignature: () => facade.getReturnTypeOfSignature(signature),
      getTypePredicateOfSignature: () => facade.getTypePredicateOfSignature(signature),
      getBaseTypeOfLiteralType: () => facade.getBaseTypeOfLiteralType(type),
      getConstantValue: () => facade.getConstantValue(name),
      getNonNullableType: () => facade.getNonNullableType(type),
      getPropertiesOfType: () => facade.getPropertiesOfType(type),
      getBaseTypes: () => facade.getBaseTypes(type),
      isNeverType: () => facade.isNeverType(never),
      isTypeAssignableTo: () => facade.isTypeAssignableTo(type, type),
      getIndexInfosOfType: () => facade.getIndexInfosOfType(type),
      getTypeArguments: () => facade.getTypeArguments(type),
      isArrayType: () => facade.isArrayType(type),
      isTupleType: () => facade.isTupleType(type),
      isArrayLikeType: () => facade.isArrayLikeType(type),
      typeToString: () => facade.typeToString(type),
      getTypeOfSymbolAtLocation: () => facade.getTypeOfSymbolAtLocation(symbol, name),
      getUnknownType: () => facade.getUnknownType(),
      getStringType: () => facade.getStringType(),
      getNumberType: () => facade.getNumberType(),
      getBooleanType: () => facade.getBooleanType(),
      getAwaitedType: () => facade.getAwaitedType(type),
    };
    const before = h.rpc.timing().requests;
    facade.dispose();
    facade.dispose();
    for (const [name, call] of Object.entries(calls))
      expect(call, name).toThrow("checker facade is disposed");
    expect(h.rpc.timing().requests).toBe(before);
    expect(project.checker.typeToString(type)).toBe("42");
  } finally {
    h.close();
  }
});

test("session shutdown invalidates every retained facade without explicit program disposal", () => {
  const h = connect({ "tsconfig.json": config, "main.ts": "export const value = 1;" });
  try {
    const snapshot = h.session.updateSnapshot({ openProjects: [h.path("tsconfig.json")] });
    const project = snapshot.getProjects()[0]!;
    const facade = new CheckerFacade(project.checker);
    const name = declaration(project.program.getSourceFile(h.path("main.ts"))!, "value").name!;
    facade.getTypeAtLocation(name);
    facade.getNumberType();
    h.session.close();
    expect(() => facade.getTypeAtLocation(name)).toThrow("disposed");
    expect(() => facade.getNumberType()).toThrow("disposed");
    expect(() => new CheckerFacade(project.checker)).toThrow("disposed");
  } finally {
    h.close();
  }
});

test("program disposal and host close seal cached source and checker access", () => {
  const dir = mkdtempSync(join(tempRoot, "scriptc-program-lifetime-"));
  const host = new Ts7Host({ cwd: dir });
  const file = join(dir, "main.ts");
  host.addVirtualFile(file, "export const value = 1;");
  try {
    const first = createProgram([file], { types: [] }, host);
    const firstFiles = first.getSourceFiles();
    const firstChecker = first.getTypeChecker();
    firstChecker.getNumberType();
    first.dispose();
    first.dispose();
    expect(() => first.getSourceFiles()).toThrow("disposed");
    expect(() => first.getTypeChecker()).toThrow("disposed");
    expect(() => firstChecker.getNumberType()).toThrow("disposed");
    expect(firstFiles.some((source) => source.fileName === protocolPath(file))).toBe(true);
    const next = createProgram([file], { types: [] }, host);
    const nextChecker = next.getTypeChecker();
    next.getSourceFiles();
    nextChecker.getNumberType();
    host.close();
    expect(() => next.getSourceFiles()).toThrow("closed");
    expect(() => next.getTypeChecker()).toThrow("closed");
    expect(() => nextChecker.getNumberType()).toThrow("disposed");
  } finally {
    host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative assignability answers remain independent in both directions", () => {
  const requests: { source?: number; target?: number }[] = [];
  const snapshot = new SemanticSnapshot(1, {
    text: (method, payload) => {
      expect(method).toBe("isTypeAssignableTo");
      const query = JSON.parse(payload) as { source: number; target: number };
      requests.push(query);
      return JSON.stringify(query.source === 1 && query.target === 2);
    },
    binary: () => {
      throw new Error("unexpected binary request");
    },
  });
  const project = snapshot.addProject("project", () => undefined);
  const facade = new CheckerFacade(new SemanticChecker(project));
  const a = project.type({ id: 1, flags: TypeFlags.NumberLiteral, value: 1 });
  const b = project.type({ id: 2, flags: TypeFlags.Number });
  for (let repeat = 0; repeat < 3; repeat++) {
    expect(facade.isTypeAssignableTo(a, b)).toBe(true);
    expect(facade.isTypeAssignableTo(b, a)).toBe(false);
    expect(facade.isTypeAssignableTo(a, a)).toBe(true);
  }
  expect(requests).toHaveLength(2);
  snapshot.dispose();
  expect(() => facade.isTypeAssignableTo(a, a)).toThrow("disposed");
  expect(() => facade.isTypeAssignableTo(b, a)).toThrow("disposed");
  expect(requests).toHaveLength(2);
});

test("property lookup caches hits and misses by type and name within each project", () => {
  const requests: string[] = [];
  let fail = true;
  const snapshot = new SemanticSnapshot(1, {
    text: (method, payload) => {
      expect(method).toBe("getPropertyOfType");
      const query = JSON.parse(payload) as { project: string; type: number; name: string };
      requests.push(`${query.project}:${query.type}:${query.name}`);
      if (query.name === "retry" && fail) {
        fail = false;
        throw new Error("transient failure");
      }
      if (query.name === "missing") return "null";
      return JSON.stringify({
        id: query.type * 10 + (query.project === "first" ? 1 : 2),
        project: query.project,
        name: query.name,
        flags: 4,
        checkFlags: 0,
      });
    },
    binary: () => {
      throw new Error("unexpected binary request");
    },
  });
  const first = snapshot.addProject("first", () => undefined);
  const second = snapshot.addProject("second", () => undefined);
  const a = new CheckerFacade(new SemanticChecker(first));
  const b = new CheckerFacade(new SemanticChecker(second));
  const firstType = first.type({ id: 1, flags: TypeFlags.Object });
  const otherType = first.type({ id: 2, flags: TypeFlags.Object });
  const secondType = second.type({ id: 1, flags: TypeFlags.Object });
  const symbol = a.getPropertyOfType(firstType, "value");
  for (let repeat = 0; repeat < 3; repeat++) {
    expect(a.getPropertyOfType(firstType, "value")).toBe(symbol);
    expect(a.getPropertyOfType(firstType, "missing")).toBeUndefined();
    expect(a.getPropertyOfType(otherType, "value")).not.toBe(symbol);
    expect(b.getPropertyOfType(secondType, "value")).not.toBe(symbol);
  }
  expect(requests).toEqual(["first:1:value", "first:1:missing", "first:2:value", "second:1:value"]);
  expect(() => a.getPropertyOfType(firstType, "retry")).toThrow("transient failure");
  expect(a.getPropertyOfType(firstType, "retry")).toBeDefined();
  a.getPropertyOfType(firstType, "retry");
  expect(requests.slice(4)).toEqual(["first:1:retry", "first:1:retry"]);
  first.dispose();
  expect(() => a.getPropertyOfType(firstType, "value")).toThrow("disposed");
  expect(() => a.getPropertyOfType(firstType, "missing")).toThrow("disposed");
  expect(b.getPropertyOfType(secondType, "value")).toBeDefined();
  snapshot.dispose();
});

test("dependency edits invalidate positive and negative property answers", () => {
  const h = connect({
    "tsconfig.json": config,
    "main.ts": 'import { value } from "./dependency.js"; export const result = value;',
    "dependency.ts": "export const value = { before: 1 };",
  });
  try {
    const first = h.session.updateSnapshot({ openProjects: [h.path("tsconfig.json")] });
    const project = first.getProjects()[0]!;
    const root = project.program.getSourceFile(h.path("main.ts"))!;
    const old = new CheckerFacade(project.checker);
    const type = old.getTypeAtLocation(declaration(root, "result").name!);
    expect(old.getPropertyOfType(type, "before")).toBeDefined();
    expect(old.getPropertyOfType(type, "after")).toBeUndefined();
    h.paths.set(h.path("dependency.ts"), "export const value = { after: 2 };");
    const second = h.session.updateSnapshot({
      fileChanges: { changed: [h.path("dependency.ts")] },
    });
    const nextProject = second.getProjects()[0]!;
    const nextRoot = nextProject.program.getSourceFile(h.path("main.ts"))!;
    expect(nextRoot).toBe(root);
    const next = new CheckerFacade(nextProject.checker);
    const nextType = next.getTypeAtLocation(declaration(nextRoot, "result").name!);
    expect(next.getPropertyOfType(nextType, "before")).toBeUndefined();
    expect(next.getPropertyOfType(nextType, "after")).toBeDefined();
    expect(old.getPropertyOfType(type, "before")).toBeDefined();
    expect(old.getPropertyOfType(type, "after")).toBeUndefined();
  } finally {
    h.close();
  }
});

test("member type batches are bounded, reuse warm entries, and isolate absent or panicking fields", () => {
  const calls: number[][] = [];
  const snapshot = new SemanticSnapshot(1, {
    text: (method, payload) => {
      if (method === "getAnyType") return JSON.stringify({ id: 1000, flags: TypeFlags.Any });
      expect(method).toBe("getTypesOfSymbols");
      const ids = (JSON.parse(payload) as { symbols: number[] }).symbols;
      calls.push(ids);
      if (ids.includes(7)) throw new Error("checker panic");
      return JSON.stringify(ids.map((id) => (id === 11 ? null : { id, flags: TypeFlags.Number })));
    },
    binary: () => {
      throw new Error("unexpected binary query");
    },
  });
  const project = snapshot.addProject("members", () => undefined);
  const facade = new CheckerFacade(new SemanticChecker(project));
  const symbols = Array.from({ length: 40 }, (_, index) =>
    snapshot.symbol({
      id: index + 1,
      project: "members",
      name: `field${index}`,
      flags: 4,
      checkFlags: 0,
    }),
  );
  facade.getTypeOfSymbol(symbols[0]!);
  facade.prefetchMemberTypes(symbols, 0);
  expect(calls[1]).toEqual(symbols.slice(1, 32).map((symbol) => symbol.id));
  expect(calls.every((ids) => ids.length <= 32 && ids.every((id) => id <= 32))).toBe(true);
  const before = calls.length;
  facade.prefetchMemberTypes(symbols, 0);
  for (const symbol of symbols.slice(0, 32)) {
    expect(facade.getTypeOfSymbol(symbol).flags).toBe(
      symbol.id === 7 || symbol.id === 11 ? TypeFlags.Any : TypeFlags.Number,
    );
  }
  expect(calls).toHaveLength(before);
  facade.prefetchMemberTypes(symbols, 32);
  expect(calls.at(-1)).toEqual(symbols.slice(32).map((symbol) => symbol.id));
  snapshot.dispose();
  expect(() => facade.prefetchMemberTypes(symbols, 0)).toThrow("disposed");
});
