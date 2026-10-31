import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { checkPreflight, loadProgram } from "./program.js";
import { createNodeFrontendServices } from "./services-node.js";
import { clearResolveCaches } from "./resolve.js";
import { FrontendInputTracker, frontendInputsStillMatch } from "./input-tracker.js";
import { lowerToIr } from "./lowering/lowerer.js";
import * as ts from "./ts7/adapter.js";
import { tsgoPath } from "./ts7/session-path.js";
import { checkPreflightTs7 } from "./program-node.js";

const directories: string[] = [];
afterEach(() => {
  clearResolveCaches();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-sidecars-"),
  );
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return directory;
}

function inspect(
  files: Record<string, string>,
  check: (load: ReturnType<typeof loadProgram>, directory: string) => void,
): void {
  const directory = fixture(files);
  const services = createNodeFrontendServices();
  clearResolveCaches();
  try {
    const load = loadProgram(join(directory, "main.ts"), services);
    try {
      check(load, directory);
    } finally {
      load.dispose();
    }
  } finally {
    services.close();
  }
}

function expectNoPreflightErrors(load: ReturnType<typeof loadProgram>): void {
  const diagnostics = checkPreflight(load);
  expect(diagnostics, JSON.stringify(diagnostics)).toEqual([]);
}

const declarations =
  "export interface Options { amount: number }\nexport declare function read(options: Options): number;\n";
const main =
  'import { read, type Options } from "./value.mjs"; const value: Options = { amount: 2 }; console.log(read(value));\n';
const implementation =
  '/** @param {import("./value.d.mts").Options} options */\nexport function read(options) { return options.amount + 1; }\n';

test.for(["js", "mjs", "cjs"])(
  "local .%s values lower from their bodies and JSDoc keeps the sidecar types",
  (extension) => {
    const declaration = "value.d." + extension.replace("js", "ts");
    const body = `/** @param {import("./${declaration}").Options} options */\nfunction read(options) { return options.amount + 1; }\n`;
    inspect(
      {
        "package.json": '{"type":"module"}',
        "main.ts": `import { read, type Options } from "./value.${extension}"; const value: Options = { amount: 2 }; console.log(read(value));\n`,
        ["value." + extension]:
          extension === "cjs"
            ? '"use strict";\n' + body + "exports.read = read;\n"
            : body + "export { read };\n",
        [declaration]: declarations,
      },
      (load, directory) => {
        expectNoPreflightErrors(load);
        const runtime = tsgoPath(join(directory, "value." + extension));
        expect(load.moduleOrder.map((file) => file.fileName)).toEqual([
          runtime,
          tsgoPath(join(directory, "main.ts")),
        ]);
        expect(load.program.getSourceFile(join(directory, declaration))).toBeUndefined();
        const source = load.program.getSourceFile(runtime)!;
        expect(source.text).toContain(".scriptc-types.d.");
        const checker = load.program.getTypeChecker();
        const imports = load.entry.statements.nodes.find(ts.isImportDeclaration)!;
        const bindings = imports.importClause!.namedBindings!;
        expect(ts.isNamedImports(bindings)).toBe(true);
        if (!ts.isNamedImports(bindings)) throw new Error("expected named import");
        const symbol = checker.getSymbolAtLocation(bindings.elements.nodes[0]!.name)!;
        expect(
          checker
            .getAliasedSymbol(symbol)
            .declarations.some((node) => ts.getSourceFileOfNode(node).fileName === runtime),
        ).toBe(true);
        const lowered = lowerToIr(load.program, load.entry, load.moduleOrder);
        expect(lowered.diagnostics, JSON.stringify(lowered.diagnostics)).toEqual([]);
        expect(lowered.runtimeFences, JSON.stringify(lowered.runtimeFences)).toEqual([]);
        expect(lowered.module).not.toBeNull();
      },
    );
  },
);

test.for([false, true])(
  "package-less=%s preserves constructor and method types in attached JSDoc",
  (packageLess) => {
    inspect(
      {
        ...(packageLess ? {} : { "package.json": '{"type":"module"}' }),
        "main.ts":
          'import { measure } from "./value.mjs"; class Meter { constructor(public amount: number) {} read(): number { return this.amount; } } console.log(measure(Meter).amount);',
        "value.mjs":
          '/** @typedef {import("./value.d.mts").Constructor} Constructor */\n/** @param {Constructor} Type @returns {import("./value.d.mts").Result} */\nexport function measure(Type) { const meter = new Type(7); return { amount: meter.read() }; }',
        "value.d.mts":
          "export interface Meter { read(): number } export type Constructor = new (amount: number) => Meter; export interface Result { amount: number } export declare function measure(Type: Constructor): Result;",
      },
      (load) => {
        expectNoPreflightErrors(load);
        const lowered = lowerToIr(load.program, load.entry, load.moduleOrder);
        expect(lowered.diagnostics, JSON.stringify(lowered.diagnostics)).toEqual([]);
        expect(lowered.runtimeFences, JSON.stringify(lowered.runtimeFences)).toEqual([]);
      },
    );
  },
);

test.for([
  'import { read } from "./value.mjs"; read({ amount: "wrong" });',
  'import { read, type Options } from "./value.mjs"; const item: Options = { amount: "wrong" }; read(item);',
  'import { read } from "./value.mjs"; const item: import("./value.d.mts").Options = { amount: "wrong" }; read(item);',
])("sidecar types still reject an invalid native call or assignment: %s", (source) => {
  inspect(
    { "main.ts": source, "value.mjs": implementation, "value.d.mts": declarations },
    (load) => {
      const semantic = load.program.getSemanticDiagnostics(load.entry);
      expect(
        semantic.some((diagnostic) => diagnostic.code === 2322),
        JSON.stringify(semantic),
      ).toBe(true);
      const diagnostics = checkPreflight(load);
      expect(diagnostics.length, JSON.stringify(diagnostics)).toBeGreaterThan(0);
    },
  );
});

test("mixed imports and reexports preserve the runtime edge and split only type bindings", () => {
  inspect(
    {
      "main.ts":
        'import { type First, read, type Last } from "./barrel.mjs"; import { type Options, } from "./value.mjs"; const item: First & Last & Options = { amount: 2 }; console.log(read(item));',
      "barrel.mjs": 'export { read } from "./value.mjs";',
      "barrel.d.mts":
        'export { read } from "./value.mjs"; export type { Options as First, Options as Last } from "./value.mjs";',
      "value.mjs": implementation,
      "value.d.mts": declarations,
    },
    (load, directory) => {
      expectNoPreflightErrors(load);
      expect(load.moduleOrder.map((file) => file.fileName)).toEqual(
        ["value.mjs", "barrel.mjs", "main.ts"].map((name) => tsgoPath(join(directory, name))),
      );
      const statements = load.entry.statements.nodes.filter(ts.isImportDeclaration);
      const empty = statements.find(
        (statement) =>
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === "./value.mjs",
      )!;
      expect(empty.importClause!.phaseModifier).not.toBe(ts.SyntaxKind.TypeKeyword);
      const bindings = empty.importClause!.namedBindings!;
      expect(ts.isNamedImports(bindings) && bindings.elements.nodes.length).toBe(0);
    },
  );
});

test("declaration cycles and a declaration selected in a later round keep one type identity", () => {
  inspect(
    {
      "main.ts":
        'import { read } from "./value.mjs"; import type { Options } from "./other.d.mts"; const item: Options = { amount: 2 }; console.log(read(item));',
      "value.mjs":
        'import { identity } from "./other.mjs";\n' +
        implementation.replace("options.amount + 1", "identity(options).amount + 1"),
      "value.d.mts":
        'export interface Options { amount: number } export type { Other } from "./other.d.mts"; export declare function read(options: Options): number;',
      "other.mjs":
        '/** @param {import("./other.d.mts").Options} value */\nexport function identity(value) { return value; }',
      "other.d.mts":
        'export type { Options } from "./value.d.mts"; export interface Other { tag: number } export declare function identity(value: import("./value.d.mts").Options): import("./value.d.mts").Options;',
    },
    (load, directory) => {
      expectNoPreflightErrors(load);
      expect(load.program.getSourceFile(join(directory, "other.d.mts"))).toBeUndefined();
      expect(
        load.program.getSourceFile(join(directory, "other.scriptc-types.d.mts"))!.text,
      ).toContain("value.scriptc-types.d.mts");
      expect(load.moduleOrder.filter((file) => file.fileName.endsWith("/other.mjs"))).toHaveLength(
        1,
      );
    },
  );
});

test("type-only dependencies and foreign package declarations do not select local runtimes", () => {
  inspect(
    {
      "main.ts":
        'import type { Options } from "./value.mjs"; import type { Foreign } from "./foreign/index.mjs"; const item: Options = { amount: 2 }; const other: Foreign = { name: "ok" }; console.log(item.amount, other.name);',
      "value.mjs": 'throw new Error("must not load");',
      "value.d.mts": declarations,
      "foreign/package.json": '{"type":"module"}',
      "foreign/index.mjs": 'throw new Error("foreign implementation");',
      "foreign/index.d.mts": "export interface Foreign { name: string }",
    },
    (load, directory) => {
      expectNoPreflightErrors(load);
      expect(load.program.getSourceFile(join(directory, "value.mjs"))).toBeUndefined();
      expect(load.program.getSourceFile(join(directory, "foreign/index.mjs"))).toBeUndefined();
      expect(
        load.program.getSourceFileNames().some((path) => path.includes(".scriptc-types")),
      ).toBe(false);
      expect(load.moduleOrder.map((file) => file.fileName)).toEqual([
        tsgoPath(join(directory, "main.ts")),
      ]);
    },
  );
});

test("aliases cannot replace authored files with the generated name", () => {
  inspect(
    {
      "main.ts": main,
      "value.mjs": implementation,
      "value.d.mts": declarations,
      "value.scriptc-types.d.mts": "export interface Authored { keep: true }",
    },
    (load, directory) => {
      expectNoPreflightErrors(load);
      expect(
        load.program.getSourceFile(join(directory, "value.scriptc-types-1.d.mts"))!.text,
      ).toContain("interface Options");
    },
  );
});

test.for([".value", ".hidden/value"])("virtual aliases of %s stay relative specifiers", (stem) => {
  inspect(
    {
      "main.ts": main.replaceAll("./value.mjs", `./${stem}.mjs`),
      [stem + ".mjs"]: implementation.replace(
        "./value.d.mts",
        stem.includes("/") ? "./value.d.mts" : "./.value.d.mts",
      ),
      [stem + ".d.mts"]: declarations,
    },
    (load) => {
      expectNoPreflightErrors(load);
      expect(load.entry.text).toContain(`"./${stem}.scriptc-types.d.mts"`);
    },
  );
});

test("foreign declaration type edges follow local aliases without admitting foreign code", () => {
  inspect(
    {
      "main.ts":
        'import { read } from "./value.mjs"; import type { Options } from "./foreign/index.mjs"; const item: Options = { amount: 2 }; console.log(read(item));',
      "value.mjs": implementation,
      "value.d.mts": declarations,
      "foreign/package.json": '{"type":"module"}',
      "foreign/index.mjs": 'throw new Error("must not load foreign implementation");',
      "foreign/index.d.mts": 'export type { Options } from "../value.d.mts";',
    },
    (load, directory) => {
      expectNoPreflightErrors(load);
      expect(load.program.getSourceFile(join(directory, "foreign/index.mjs"))).toBeUndefined();
      expect(load.program.getSourceFile(join(directory, "foreign/index.d.mts"))!.text).toContain(
        "../value.scriptc-types.d.mts",
      );
      expect(load.moduleOrder.map((file) => file.fileName)).toEqual(
        ["value.mjs", "main.ts"].map((name) => tsgoPath(join(directory, name))),
      );
    },
  );
});

test("cached inputs track the original sidecar and pooled reloads observe its changed types", () => {
  const directory = fixture({
    "main.ts": main,
    "value.mjs": implementation,
    "value.d.mts": declarations,
  });
  const entry = join(directory, "main.ts");
  const sidecar = join(directory, "value.d.mts");
  const services = createNodeFrontendServices();
  services.reuseProgramHosts(4);
  const hosts = vi.spyOn(services, "createProgramHost");
  const tracker = new FrontendInputTracker();
  try {
    tracker.run(() => {
      const load = loadProgram(entry, services);
      try {
        expectNoPreflightErrors(load);
      } finally {
        load.dispose();
      }
    });
    const snapshot = tracker.snapshot();
    expect(snapshot.stable).toBe(true);
    expect(snapshot.probes.some((probe) => probe.op === "file" && probe.path === sidecar)).toBe(
      true,
    );
    expect(frontendInputsStillMatch(snapshot)).toBe(true);
    writeFileSync(sidecar, declarations.replace("amount: number", "amount: string"));
    expect(frontendInputsStillMatch(snapshot)).toBe(false);
    clearResolveCaches();
    const next = loadProgram(entry, services);
    try {
      const diagnostics = checkPreflight(next);
      expect(diagnostics.length, JSON.stringify(diagnostics)).toBeGreaterThan(0);
      expect(
        next.program.getSourceFile(join(directory, "value.scriptc-types.d.mts"))!.text,
      ).toContain("amount: string");
    } finally {
      next.dispose();
    }
    expect(hosts.mock.results[0]!.value).toBe(hosts.mock.results[1]!.value);
    writeFileSync(
      entry,
      'import type { Options } from "./value.mjs"; const item: Options = { amount: "ok" }; console.log(item.amount);',
    );
    clearResolveCaches();
    const onlyTypes = loadProgram(entry, services);
    try {
      expectNoPreflightErrors(onlyTypes);
      expect(onlyTypes.program.getSourceFile(sidecar)).toBeDefined();
      expect(
        onlyTypes.program.getSourceFileNames().some((path) => path.includes(".scriptc-types")),
      ).toBe(false);
    } finally {
      onlyTypes.dispose();
    }
  } finally {
    services.close();
  }
});

test("a dynamic-import-only sidecar keeps its existing declaration boundary", () => {
  inspect(
    {
      "main.ts":
        'async function run() { const values = await import("./value.mjs"); console.log(values.read({ amount: 2 })); } run();',
      "value.mjs": implementation,
      "value.d.mts": declarations,
    },
    (load, directory) => {
      expectNoPreflightErrors(load);
      expect(load.program.getSourceFile(join(directory, "value.d.mts"))).toBeDefined();
      expect(load.program.getSourceFile(join(directory, "value.mjs"))).toBeUndefined();
      expect(load.moduleOrder.map((file) => file.fileName)).toEqual([
        tsgoPath(join(directory, "main.ts")),
      ]);
    },
  );
});

test("a local require binding does not admit or initialize its literal argument's sidecar", () => {
  inspect(
    {
      "main.ts": 'import { value } from "./caller.cjs"; console.log(value);',
      "caller.cjs":
        '"use strict"; function require(path) { return { value: 5 }; } exports.value = require("./value.cjs").value;',
      "value.cjs": 'throw new Error("must not initialize"); exports.value = 2;',
      "value.d.cts": "export declare const value: number;",
    },
    (load, directory) => {
      expectNoPreflightErrors(load);
      expect(load.moduleOrder.map((file) => file.fileName)).toEqual(
        ["caller.cjs", "main.ts"].map((name) => tsgoPath(join(directory, name))),
      );
      expect(load.program.getSourceFile(join(directory, "value.cjs"))).toBeUndefined();
    },
  );
});

test("inline diagnostic spans refer to the offending token in the projected program", () => {
  inspect(
    {
      "main.ts":
        'import { read, type Options } from "./value.mjs"; const item: Options = { amount: "wrong" }; console.log(read(item));',
      "value.mjs": implementation,
      "value.d.mts": declarations,
    },
    (load) => {
      const diagnostics = checkPreflight(load);
      const diagnostic = diagnostics.find((item) => item.code === "SC0001")!;
      expect(diagnostic, JSON.stringify(diagnostics)).toBeDefined();
      expect(diagnostic.loc.file, JSON.stringify(diagnostics)).toBe(load.entry.fileName);
      expect(
        load.entry.text.slice(diagnostic.loc.start, diagnostic.loc.end),
        JSON.stringify(diagnostics),
      ).toBe("amount");
      expect(diagnostic.loc.start, JSON.stringify(diagnostics)).toBe(
        load.entry.text.indexOf('amount: "wrong"'),
      );
    },
  );
});

test("the order canary uses the same sidecar plan and restores its caller-owned host", () => {
  const directory = fixture({
    "main.ts": main,
    "value.mjs": implementation,
    "value.d.mts": declarations,
  });
  const services = createNodeFrontendServices();
  const host = services.createProgramHost({ cwd: directory });
  const retained = join(directory, "retained.ts");
  host.addVirtualFile(retained, "export const retained = true;");
  try {
    const answer = checkPreflightTs7(join(directory, "main.ts"), host);
    expect(answer.diags, JSON.stringify(answer.diags)).toEqual([]);
    expect(answer.moduleOrder).toEqual(
      ["value.mjs", "main.ts"].map((name) => tsgoPath(join(directory, name))),
    );
    expect(host.virtualFileText(retained)).toBe("export const retained = true;");
    expect(host.virtualFileText(join(directory, "value.scriptc-types.d.mts"))).toBeUndefined();
    writeFileSync(
      join(directory, "main.ts"),
      'import type { Options } from "./value.mjs"; const item: Options = { amount: 2 }; console.log(item.amount);',
    );
    const next = checkPreflightTs7(join(directory, "main.ts"), host);
    expect(next.diags, JSON.stringify(next.diags)).toEqual([]);
    expect(next.moduleOrder).toEqual([tsgoPath(join(directory, "main.ts"))]);
  } finally {
    host.close();
    services.close();
  }
});

test("a static chain longer than the root-discovery guard converges before reconstruction", () => {
  const count = 40;
  const files: Record<string, string> = {
    "main.ts": 'import { value } from "./part0.mjs"; console.log(value);',
  };
  for (let index = 0; index < count; index++) {
    files[`part${index}.mjs`] =
      index + 1 === count
        ? "export const value = 1;"
        : `import { value as next } from "./part${index + 1}.mjs"; export const value = next + 1;`;
    files[`part${index}.d.mts`] = "export declare const value: number;";
  }
  inspect(files, (load) => {
    expectNoPreflightErrors(load);
    expect(load.moduleOrder).toHaveLength(count + 1);
    expect(load.moduleOrder[0]!.fileName).toMatch(/\/part39\.mjs$/);
    const lowered = lowerToIr(load.program, load.entry, load.moduleOrder);
    expect(lowered.diagnostics, JSON.stringify(lowered.diagnostics)).toEqual([]);
    expect(lowered.runtimeFences, JSON.stringify(lowered.runtimeFences)).toEqual([]);
  });
});

test("creating a previously missing sidecar invalidates a reusable frontend input snapshot", () => {
  const directory = fixture({
    "main.ts": 'import { value } from "./value.mjs"; console.log(value);',
    "value.mjs": "export const value = 3;",
  });
  const services = createNodeFrontendServices();
  const tracker = new FrontendInputTracker();
  try {
    tracker.run(() => {
      const load = loadProgram(join(directory, "main.ts"), services);
      try {
        expectNoPreflightErrors(load);
      } finally {
        load.dispose();
      }
    });
    const snapshot = tracker.snapshot();
    expect(
      snapshot.probes.some(
        (probe) =>
          probe.op === "kind" &&
          probe.path === join(directory, "value.d.mts") &&
          probe.kind === "missing",
      ),
    ).toBe(true);
    expect(frontendInputsStillMatch(snapshot)).toBe(true);
    writeFileSync(join(directory, "value.d.mts"), "export declare const value: number;");
    expect(frontendInputsStillMatch(snapshot)).toBe(false);
  } finally {
    services.close();
  }
});
