import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { FrontendServices, type ComptimeEvaluator } from "./services.js";
import { Ts7Api } from "./ts7/rpc-api.js";
import { checkPreflight, isNodeEsmFile, loadProgram } from "./program.js";
import { clearResolveCaches } from "./resolve.js";
import type { Ts7ApiOptions } from "./ts7/program-host.js";
import { getTextOfNode } from "./ts7/node-functions.js";

const directories: string[] = [];
afterEach(() => {
  clearResolveCaches();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(evaluator?: ComptimeEvaluator) {
  const dir = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-services-"),
  );
  directories.push(dir);
  const connections: { api: Ts7Api; close: ReturnType<typeof vi.spyOn>; options: Ts7ApiOptions }[] =
    [];
  const factory = vi.fn((options: Ts7ApiOptions) => {
    const api = new Ts7Api(options);
    connections.push({ api, close: vi.spyOn(api, "close"), options });
    return api;
  });
  return { dir, connections, factory, services: new FrontendServices(factory, dir, evaluator) };
}

test("compile-time execution belongs to the supplied host and closes with its services", () => {
  const value = { table: [1, 2, 3] };
  const evaluate = vi.fn(() => value);
  const { services, factory } = setup(evaluate);
  expect(services.evaluateComptime("() => [1, 2, 3]", 2000)).toBe(value);
  expect(evaluate).toHaveBeenCalledExactlyOnceWith("() => [1, 2, 3]", 2000);
  expect(factory).not.toHaveBeenCalled();
  services.close();
  expect(() => services.evaluateComptime("() => 1", 2000)).toThrow("closed");
  expect(evaluate).toHaveBeenCalledTimes(1);
});

test("a host without a compile-time evaluator refuses explicitly", () => {
  const { services, factory } = setup();
  try {
    expect(() => services.evaluateComptime("() => 1", 2000)).toThrow(
      "does not provide compile-time evaluation",
    );
  } finally {
    services.close();
  }
  expect(factory).not.toHaveBeenCalled();
});

test("service construction and irrelevant rewrites open no connections", () => {
  const { services, factory } = setup();
  expect(services.rewriteCjs("exports.value = 1;", "index.js")).toBeNull();
  expect(services.declarationOverloads("index.js", "", new Map())).toBeNull();
  expect(services.declarationProperties("index.js", "", new Map())).toBeNull();
  services.close();
  services.close();
  expect(factory).not.toHaveBeenCalled();
  expect(() => services.parse("a.ts", "", "ts")).toThrow("closed");
  expect(() => services.createProgramHost()).toThrow("closed");
  expect(() => services.rewriteCjs("", "a.js")).toThrow("closed");
  expect(() => services.declarationOverloads("a.js", "", new Map())).toThrow("closed");
  expect(() => services.declarationProperties("a.js", "", new Map())).toThrow("closed");
});

test("syntax sessions reuse one connection and returned ASTs survive edits and close", () => {
  const { services, connections } = setup();
  const before = services.parse("a.ts", "export const before = 1;", "ts");
  expect(services.parse("a.ts", before.text, "ts")).toBe(before);
  const after = services.parse("a.ts", "export const after = 2;", "ts");
  expect(after).not.toBe(before);
  expect(before.text).toBe("export const before = 1;");
  expect(after.text).toBe("export const after = 2;");
  expect(connections).toHaveLength(1);
  expect(connections[0]!.options.collectTiming).toBe(false);
  services.close();
  services.close();
  expect(connections[0]!.close).toHaveBeenCalledTimes(1);
  expect(getTextOfNode(before.statements.nodes[0]!)).toBe(before.text);
});

test("program hosts remain usable after their creating services close", () => {
  const { services, connections, dir } = setup();
  const host = services.createProgramHost();
  expect(connections[0]!.options.cwd).toBe(dir);
  services.parse("syntax.js", "exports.value = 1;", "js");
  services.close();
  expect(connections[0]!.close).not.toHaveBeenCalled();
  expect(connections[1]!.close).toHaveBeenCalledTimes(1);
  host.addVirtualFile(join(dir, "main.ts"), "export const value = 1;");
  const program = host.createProgram([join(dir, "main.ts")], { noLib: true, types: [] });
  try {
    expect(program.getSourceFile(join(dir, "main.ts"))!.text).toBe("export const value = 1;");
  } finally {
    program.dispose();
    host.close();
  }
  expect(connections[0]!.close).toHaveBeenCalledTimes(1);
});

test("load failure releases the newly opened program host and keeps supplied services reusable", () => {
  const { services, connections, dir } = setup();
  try {
    expect(() => loadProgram(join(dir, "missing.ts"), services)).toThrow("could not load");
    expect(connections).toHaveLength(1);
    expect(connections[0]!.close).toHaveBeenCalledTimes(1);
    const entry = join(dir, "main.ts");
    writeFileSync(entry, "export const value = 1;");
    const load = loadProgram(entry, services);
    try {
      expect(checkPreflight(load)).toEqual([]);
    } finally {
      load.dispose();
      load.dispose();
    }
    expect(connections[1]!.close).toHaveBeenCalledTimes(1);
    expect(services.parse("a.ts", "export {};", "ts").text).toBe("export {};");
  } finally {
    services.close();
  }
});

test("a malformed load option is rejected before opening any connection", () => {
  const { services, factory, dir } = setup();
  try {
    expect(() =>
      loadProgram(join(dir, "main.ts"), services, { externalTypes: [["wild/*", "missing.d.ts"]] }),
    ).toThrow("invalid external type specifier");
    expect(factory).not.toHaveBeenCalled();
  } finally {
    services.close();
  }
});

test("Node format decisions belong to their program even when source ASTs are reused", () => {
  const { services, dir } = setup();
  const sourcePath = join(dir, "main.js");
  const packagePath = join(dir, "package.json");
  writeFileSync(sourcePath, "console.log(1);");
  writeFileSync(packagePath, '{"type":"module"}');
  const host = services.createProgramHost({ cwd: dir });
  const first = host.createProgram([sourcePath], { allowJs: true, noLib: true, types: [] });
  try {
    const source = first.getSourceFile(sourcePath)!;
    expect(isNodeEsmFile(source, first)).toBe(true);
    writeFileSync(packagePath, '{"type":"commonjs"}');
    clearResolveCaches();
    const next = host.createProgram([sourcePath], { allowJs: true, noLib: true, types: [] });
    try {
      // Deliberately ask about the same detached syntax object: its source
      // bytes did not change, while the surrounding package policy did.
      expect(isNodeEsmFile(source, next)).toBe(false);
      expect(isNodeEsmFile(source, first)).toBe(true);
      expect(isNodeEsmFile(source)).toBe(false);
    } finally {
      next.dispose();
    }
    expect(next.analysis.nodeEsmFiles.size).toBe(0);
  } finally {
    first.dispose();
    host.close();
    services.close();
  }
  expect(first.analysis.nodeEsmFiles.size).toBe(0);
});
