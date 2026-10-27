import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { API, type Snapshot, type Symbol as SdkSymbol } from "typescript/unstable/sync";
import { Ts7Api, ts7Executable } from "../../src/frontend/ts7/rpc-api.js";
import { Ts7RpcClient } from "../../src/frontend/ts7/rpc-client.js";
import type { Ts7FileSystem } from "../../src/frontend/ts7/rpc-filesystem.js";
import { spawnTs7Wire } from "../../src/frontend/ts7/rpc-process.js";
import { AstNode } from "../../src/frontend/ts7/ast-node.js";
import { SemanticChecker } from "../../src/frontend/ts7/semantic-checker.js";
import {
  SemanticNodeHandle,
  SemanticSignature,
  SemanticSymbol,
  SemanticType,
  symbolName,
} from "../../src/frontend/ts7/semantic-model.js";
import { ts7Diagnostic, type Ts7Diagnostic } from "../../src/frontend/ts7/diagnostic.js";
import type { Ts7DiagnosticData } from "../../src/frontend/ts7/session-schema.generated.js";

// The SDK's symbols have `name`; scriptc's give it with symbolName, which reads `escapedName`, as the
// SDK's symbols also have it.
function nameOf(symbol: SdkSymbol): string {
  return symbolName(symbol as unknown as SemanticSymbol);
}

// scriptc's diagnostics have every member set; the SDK's leave absent ones out.
function diagnostics(list: readonly unknown[]): Ts7Diagnostic[] {
  return list.map((item) => ts7Diagnostic(item as Ts7DiagnosticData));
}

// scriptc's symbols keep their declarations' node handles in
// `declarationHandles`, and the SDK's in `declarations`.
function declarationHandlesOf(symbol: SdkSymbol): SdkSymbol["declarations"] {
  return (
    (symbol as unknown as { declarationHandles?: SdkSymbol["declarations"] }).declarationHandles ??
    symbol.declarations
  );
}

function tsgoPath(path: string): string {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const fallback: Ts7FileSystem = {
  readFile: () => undefined,
  fileExists: () => undefined,
  directoryExists: () => undefined,
  realpath: () => undefined,
  getAccessibleEntries: () => undefined,
};

function programFacts(snapshot: Snapshot, config: string, path: string) {
  const project = snapshot.getProject(config)!;
  const file = project.program.getSourceFile(path)!;
  const checker = project.checker;
  const position = file.text.indexOf("answer");
  const type = checker.getTypeAtPosition(path, position)!;
  const symbol = checker.getSymbolAtPosition(path, position)!;
  return {
    roots: project.rootFiles,
    files: project.program.getSourceFileNames(),
    options: project.program.getCompilerOptions(),
    text: file.text,
    type: checker.typeToString(type),
    symbol: nameOf(symbol),
    declaration: declarationHandlesOf(symbol)[0]!.resolve()!.getText(file),
    syntactic: diagnostics(project.program.getSyntacticDiagnostics(path)),
    semantic: diagnostics(project.program.getSemanticDiagnostics(path)),
    globals: diagnostics(project.program.getGlobalDiagnostics()),
    config: diagnostics(project.program.getConfigFileParsingDiagnostics()),
    defaultLibrary: project.program.isSourceFileDefaultLibrary(file),
    externalLibrary: project.program.isSourceFileFromExternalLibrary(file),
  };
}

test("production RPC bridge preserves pinned SDK parser/checker behavior", () => {
  const dir = mkdtempSync(join(tempRoot, "scriptc-ts7-rpc-parity-"));
  const config = tsgoPath(join(dir, "tsconfig.json"));
  const path = tsgoPath(join(dir, "main.ts"));
  writeFileSync(
    config,
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: [path] }),
  );
  writeFileSync(path, 'export const answer = 42;\nexport const invalid: number = "wrong";\n');
  // Compared with the pinned SDK, which runs tsgo, so the bridge runs tsgo too.
  const checker = process.env["SCRIPTC_CHECKER"];
  process.env["SCRIPTC_CHECKER"] = "tsgo";
  let nativeClient: Ts7Api;
  try {
    nativeClient = new Ts7Api({ cwd: dir, fs: fallback });
  } finally {
    if (checker === undefined) delete process.env["SCRIPTC_CHECKER"];
    else process.env["SCRIPTC_CHECKER"] = checker;
  }
  const sdk = new API({ cwd: dir });
  try {
    expect(nativeClient.parseConfigFile(config)).toEqual(sdk.parseConfigFile(config));
    const expected = sdk.updateSnapshot({ openProjects: [config] });
    const actual = nativeClient.updateSnapshot({ openProjects: [config] });
    const facts = programFacts(actual as unknown as Snapshot, config, path);
    expect(facts).toEqual(programFacts(expected, config, path));
    expect(facts.type).toBe("42");
    expect(facts.symbol).toBe("answer");
    expect(facts.semantic.map((diagnostic) => diagnostic.code)).toEqual([2322]);
    const project = actual.getProject(config)!;
    const source = project.program.getSourceFile(path)!;
    expect(source).toBeInstanceOf(AstNode);
    expect(project.program.getSourceFile(path)).toBe(source);
    const first = project.checker.getTypeAtPosition(path, source.text.indexOf("answer"));
    expect(project.checker).toBeInstanceOf(SemanticChecker);
    expect(first).toBeInstanceOf(SemanticType);
    expect(project.checker.getTypeAtPosition(path, source.text.indexOf("answer"))).toBe(first);
    const symbol = project.checker.getSymbolAtPosition(path, source.text.indexOf("answer"));
    expect(symbol).toBeInstanceOf(SemanticSymbol);
    expect(symbol!.declarationHandles[0]).toBeInstanceOf(SemanticNodeHandle);
    expect(project.checker.getSymbolAtPosition(path, source.text.indexOf("answer"))).toBe(symbol);
    expect(symbol!.declarationHandles[0]!.resolve()).toBe(symbol!.declarationHandles[0]!.resolve());
    const declaration = symbol!.declarationHandles[0]!.resolve()!;
    expect(declaration).toBeInstanceOf(AstNode);
    const variable = source.statements
      .nodes[0]! as import("../../src/frontend/ts7/ast-types.js").VariableStatement;
    expect(variable.declarationList.declarations.nodes[0]).toBe(declaration);
    expect(
      project.checker.getSymbolAtLocation(variable.declarationList.declarations.nodes[0]!.name),
    ).toBe(symbol);
    expect(
      project.checker.getTypeAtLocation(variable.declarationList.declarations.nodes[0]!.name),
    ).toBe(first);
    const expectedSource = expected.getProject(config)!.program.getSourceFile(path)!;
    expect(source.statements.nodes.map((node) => [node.kind, node.pos, node.end])).toEqual(
      expectedSource.statements.map((node) => [node.kind, node.pos, node.end]),
    );
    // A list carries its own position, as tsc-ts's NodeList does, and its
    // nodes are a plain array that retains element identity.
    expect([source.statements.pos, source.statements.end]).toEqual([
      expectedSource.statements.pos,
      expectedSource.statements.end,
    ]);
    expect(Array.isArray(source.statements.nodes)).toBe(true);
    expect(Object.hasOwn(source.statements.nodes, "pos")).toBe(false);
    expect(Object.hasOwn(source.statements, "transformFlags")).toBe(false);
    expect(source.referencedFiles).toBe(source.referencedFiles);
    expect(source.imports).toBe(source.imports);
  } finally {
    nativeClient.close();
    sdk.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshots share unchanged source files and release independently", () => {
  const dir = mkdtempSync(join(tempRoot, "scriptc-ts7-rpc-snapshots-"));
  const config = tsgoPath(join(dir, "tsconfig.json"));
  const path = tsgoPath(join(dir, "main.ts"));
  writeFileSync(config, JSON.stringify({ compilerOptions: { types: [] }, files: [path] }));
  writeFileSync(path, "export const answer = 42;\n");
  const api = new Ts7Api({ cwd: dir, fs: fallback });
  try {
    const first = api.updateSnapshot({ openProjects: [config] });
    const firstFile = first.getProject(config)!.program.getSourceFile(path);
    const second = api.updateSnapshot({ openProjects: [] });
    expect(second.getProject(config)!.program.getSourceFile(path)).toBe(firstFile);
    first.dispose();
    first.dispose();
    expect(() => first.getProjects()).toThrow("disposed");
    expect(second.getProject(config)!.program.getSourceFile(path)).toBe(firstFile);
    // Releasing the server baseline removes the proof that cached syntax is
    // unchanged. Re-fetch even an unchanged file after the latest disposal.
    second.dispose();
    const third = api.updateSnapshot({ openProjects: [] });
    const thirdFile = third.getProject(config)!.program.getSourceFile(path)!;
    expect(thirdFile).not.toBe(firstFile);
    expect(thirdFile.text).toBe(firstFile!.text);
    third.dispose();
    writeFileSync(path, 'export const answer = "updated";\n');
    const fourth = api.updateSnapshot({ fileChanges: { changed: [path] } });
    const project = fourth.getProject(config)!;
    const updated = project.program.getSourceFile(path)!;
    expect(updated.text).toBe('export const answer = "updated";\n');
    expect(updated).not.toBe(thirdFile);
    expect(
      project.checker.typeToString(
        project.checker.getTypeAtPosition(path, updated.text.indexOf("answer"))!,
      ),
    ).toBe('"updated"');
    expect(firstFile!.text).toBe("export const answer = 42;\n");
    api.close();
    expect(fourth.isDisposed()).toBe(true);
    expect(() => api.parseConfigFile(config)).toThrow("closed");
    expect(() => api.updateSnapshot({ openProjects: [] })).toThrow("closed");
    expect(() => api.getTimingInfo()).toThrow("closed");
  } finally {
    api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native semantic registries preserve project scope and snapshot lifetimes", () => {
  const dir = mkdtempSync(join(tempRoot, "scriptc-ts7-semantic-scopes-"));
  const firstConfig = tsgoPath(join(dir, "first.json"));
  const secondConfig = tsgoPath(join(dir, "second.json"));
  const path = tsgoPath(join(dir, "shared.ts"));
  for (const config of [firstConfig, secondConfig])
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { strict: true, target: "esnext", types: [] },
        files: [path],
      }),
    );
  const source =
    "export function identity<T>(value: T): T { return value; }\nexport const answer = 42;\n";
  writeFileSync(path, source);
  const api = new Ts7Api({ cwd: dir, fs: fallback });
  const sdk = new API({ cwd: dir });
  // scriptc's node lists keep their nodes in `nodes`; the SDK's lists are arrays.
  type SdkNode = import("typescript/unstable/ast").Node;
  const nodesOf = (list: unknown): readonly SdkNode[] =>
    Array.isArray(list) ? list : (list as { nodes: readonly SdkNode[] }).nodes;
  function facts(snapshot: Snapshot) {
    const a = snapshot.getProject(firstConfig)!;
    const b = snapshot.getProject(secondConfig)!;
    const answer = source.indexOf("answer");
    const symbolA = a.checker.getSymbolAtPosition(path, answer)!;
    const symbolB = b.checker.getSymbolAtPosition(path, answer)!;
    const typeA = a.checker.getTypeAtPosition(path, answer)!;
    const typeB = b.checker.getTypeAtPosition(path, answer)!;
    const fileA = a.program.getSourceFile(path)!;
    const fileB = b.program.getSourceFile(path)!;
    const signatureA = a.checker.getSignatureFromDeclaration(nodesOf(fileA.statements)[0]!)!;
    const signatureB = b.checker.getSignatureFromDeclaration(nodesOf(fileB.statements)[0]!)!;
    return {
      shape: {
        sharedSymbol: symbolA === symbolB,
        sharedType: typeA === typeB,
        sharedSignature: signatureA === signatureB,
        sameDeclaration:
          declarationHandlesOf(symbolA)[0]!.resolve() ===
          declarationHandlesOf(symbolB)[0]!.resolve(),
        explicitDeclaration:
          declarationHandlesOf(symbolB)[0]!.resolve(b) ===
          nodesOf(
            (nodesOf(fileB.statements)[1] as import("typescript/unstable/ast").VariableStatement)
              .declarationList.declarations,
          )[0],
        texts: [a.checker.typeToString(typeA), b.checker.typeToString(typeB)],
        parameters: signatureA.getParameters().map(nameOf),
      },
      symbolA,
      typeA,
      signatureA,
      fileA,
    };
  }
  try {
    const first = api.updateSnapshot({ openProjects: [firstConfig, secondConfig] });
    const actual = facts(first as unknown as Snapshot);
    expect(actual.shape).toEqual(
      facts(sdk.updateSnapshot({ openProjects: [firstConfig, secondConfig] })).shape,
    );
    expect(actual.signatureA).toBeInstanceOf(SemanticSignature);
    expect(actual.typeA).toBeInstanceOf(SemanticType);
    const second = api.updateSnapshot({ openProjects: [] });
    const next = facts(second as unknown as Snapshot);
    expect(next.fileA).toBe(actual.fileA);
    expect(next.typeA).not.toBe(actual.typeA);
    expect(next.symbolA).not.toBe(actual.symbolA);
    expect(next.signatureA).not.toBe(actual.signatureA);
    first.dispose();
    expect(() => actual.typeA.getSymbol()).toThrow("disposed");
    expect(() => declarationHandlesOf(actual.symbolA)[0]!.resolve()).toThrow("disposed");
    expect(nameOf(next.signatureA.getParameters()[0]!)).toBe("value");
    expect(second.getProject(firstConfig)!.checker.typeToString(next.typeA)).toBe("42");
    second.dispose();
    expect(() => next.signatureA.getParameters()).toThrow("disposed");
  } finally {
    api.close();
    sdk.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("virtual filesystem callbacks retain empty, hidden, and fallback files", () => {
  const dir = mkdtempSync(join(tempRoot, "scriptc-ts7-rpc-fs-"));
  const config = tsgoPath(join(dir, "virtual.json"));
  const empty = tsgoPath(join(dir, "empty.ts"));
  const hidden = tsgoPath(join(dir, "hidden.ts"));
  const real = tsgoPath(join(dir, "real.ts"));
  const virtual = tsgoPath(join(dir, "virtual.ts"));
  writeFileSync(empty, "invalid syntax !!!");
  writeFileSync(hidden, "export const hidden = 1;");
  writeFileSync(real, "export const real = 2;");
  const reads = new Set<string>();
  const fs: Ts7FileSystem = {
    ...fallback,
    readFile(path) {
      reads.add(path);
      if (path === config)
        return JSON.stringify({
          compilerOptions: { types: [] },
          files: [empty, hidden, real, virtual],
        });
      if (path === empty) return "";
      if (path === hidden) return null;
      if (path === virtual) return 'export const answer = "virtual";';
      return undefined;
    },
    fileExists: (path) =>
      path === hidden
        ? false
        : path === empty || path === virtual || path === config
          ? true
          : undefined,
  };
  const api = new Ts7Api({ cwd: dir, fs });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    const program = snapshot.getProject(config)!.program;
    expect(program.getSourceFile(empty)!.text).toBe("");
    expect(program.getSourceFile(hidden)).toBeUndefined();
    expect(program.getSourceFile(real)!.text).toBe("export const real = 2;");
    expect(program.getSourceFile(virtual)!.text).toContain('"virtual"');
    expect(program.getSyntacticDiagnostics()).toEqual([]);
    expect(reads.has(config)).toBe(true);
    expect(reads.has(real)).toBe(true);
  } finally {
    api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("request and AST materialization timing keeps the existing public shape", () => {
  const dir = mkdtempSync(join(tempRoot, "scriptc-ts7-rpc-timing-"));
  const config = tsgoPath(join(dir, "tsconfig.json"));
  const path = tsgoPath(join(dir, "main.ts"));
  writeFileSync(config, JSON.stringify({ compilerOptions: { types: [] }, files: [path] }));
  writeFileSync(path, "export const answer = 42;\n");
  const api = new Ts7Api({ cwd: dir, fs: fallback, collectTiming: true });
  const disabled = new Ts7Api({ cwd: dir, fs: fallback });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    programFacts(snapshot, config, path);
    const timing = api.getTimingInfo();
    expect(timing.enabled).toBe(true);
    expect(timing.totals.requestCount).toBeGreaterThan(10);
    expect(timing.totals.bytesSent).toBeGreaterThan(0);
    expect(timing.totals.bytesReceived).toBeGreaterThan(0);
    expect(timing.totals.sourceFilesFetched).toBe(1);
    expect(timing.totals.nodesMaterialized).toBeGreaterThan(0);
    expect(timing.totals.nodesFetched).toBeGreaterThanOrEqual(timing.totals.nodesMaterialized);
    expect(timing.recentRequests).toHaveLength(5);
    expect(api.getTimingInfo().totals.requestCount).toBe(timing.totals.requestCount);
    expect(disabled.getTimingInfo().enabled).toBe(false);
    expect(disabled.getTimingInfo().totals.requestCount).toBe(0);
  } finally {
    api.close();
    disabled.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real server refusals leave the production process channel reusable", () => {
  const client = new Ts7RpcClient(spawnTs7Wire(ts7Executable(), ["--api", "--cwd", process.cwd()]));
  try {
    expect(() => client.requestText("scriptcUnknownMethod", "null")).toThrow();
    expect(client.requestText("echo", "after error")).toBe("after error");
    expect(JSON.parse(client.requestText("initialize", "null"))).toHaveProperty("currentDirectory");
  } finally {
    client.close();
  }
});

test("failed process startup has no uncaught error or leaked exit hook", async () => {
  const before = process.listenerCount("exit");
  expect(() => spawnTs7Wire(join(tempRoot, "scriptc-ts7-does-not-exist", "tsgo"), [])).toThrow(
    "Unable to start TypeScript server",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(process.listenerCount("exit")).toBe(before);
});

test("live process transports share one removable exit hook", () => {
  const before = process.listenerCount("exit");
  const first = spawnTs7Wire(ts7Executable(), ["--api", "--cwd", process.cwd()]);
  const second = spawnTs7Wire(ts7Executable(), ["--api", "--cwd", process.cwd()]);
  try {
    expect(process.listenerCount("exit")).toBe(before + 1);
    first.close();
    expect(process.listenerCount("exit")).toBe(before + 1);
    second.close();
    expect(process.listenerCount("exit")).toBe(before);
  } finally {
    first.close();
    second.close();
  }
});
