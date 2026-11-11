import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import ts5 from "typescript5";
import {
  elideImports,
  elideProgramImports,
  importElisionOptions,
  type ImportElision,
  type ImportElisionOptions,
} from "../src/frontend/import-elision.js";
import { Ts7Api } from "../src/frontend/ts7/api.js";
import { loadProgram } from "../src/frontend/program-node.js";
import { Ts7Host } from "../src/frontend/ts7/program-host.js";
import { Ts7RpcClient } from "../src/frontend/ts7/rpc-client.js";
import { TS7_FILE_SYSTEM_CALLBACKS } from "../src/frontend/ts7/rpc-filesystem.js";
import { spawnTs7Wire } from "../src/frontend/ts7/rpc-process.js";
import { SemanticChecker } from "../src/frontend/ts7/semantic-checker.js";
import { ts7TestServers, type Ts7TestServer } from "../src/frontend/ts7/test-servers.js";

/* The oracle is tsc itself: each case below is a module of one program,
 * TypeScript 5.9 emits the program, and the imports and exports that survive
 * in its output must be the ones that survive in the rewritten source. */

const FILES: Record<string, string> = {
  "import-aliases.ts": `import * as V from "./values";
import * as W from "./values";
import * as X from "./values";
import * as Y from "./values";
import * as Z from "./values";
namespace N {
  import fn = V.f;
  export const r = fn();
  import unused = W.f;
  export import kept = X.a;
}
import top = Y.a;
import dead = Z.a;
console.log(N.r, top);
`,
  "type-alias-of-import.ts": `import * as V from "./values";
import T = V.OnlyTypes;
let p: T.P | undefined;
console.log(p);
`,
  "only-empty-imports.ts": `import {} from "./values";
import { type I } from "./types";
const i: I = { x: 1 };
console.log(i);
`,
  "ambient.ts": `import { C, a, f } from "./values";
import { C as C3 } from "./values";
declare class DC extends C {}
declare const q: typeof a;
declare namespace M { const z: typeof f; }
declare function h(x: C3): void;
let dc: DC | undefined;
console.log(dc);
`,
  "computed-names-in-types.ts": `import { key, sym } from "./values";
import { key as key2, sym as sym2 } from "./values";
import { key as key3 } from "./values";
import { key as key4, sym as sym4 } from "./values";
declare class DC { [key]: string; [sym](): void; }
declare const dq: { [key2]: string; [sym2]: number };
let lit: { [key3]: string } | undefined;
function fn(x: { [key4]: string }): typeof sym4 | undefined { return undefined; }
console.log(lit, fn);
`,
  "computed-names.ts": `import { key, sym, a } from "./values";
import { key as key2, sym as sym2 } from "./values";
interface Q { [key]: string; [sym]: number }
type R = { [key2]: string };
class Z { [key2] = 1; [sym2] = 2; }
console.log(Z);
`,
  "const-enums.ts": `import { CE, NS, OnlyConst, E } from "./values";
import * as V from "./values";
import * as V2 from "./values";
console.log(CE.X, NS.Inner.Q, OnlyConst.K.Z, V.CE.Y, V2.E.A);
enum F { A = E.A }
console.log(F.A);
`,
  "decorators-and-generics.ts": `import { C, f, a } from "./values";
import { C as C2, f as f2 } from "./values";
function dec(target: unknown, context: unknown): void {}
@dec class X { @dec m(): void {} }
const t = \`\${a}\`;
function gen<T extends C2 = C2>(x: T, y: ReturnType<typeof f2>): void {}
console.log(X, t, gen);
export type { C };
`,
  "default-export-type.ts": `import { I } from "./types";
export default I;
`,
  "default-export-value.ts": `import { a } from "./values";
export default a;
`,
  "default-type-named-value.ts": `import D, { C, f } from "./values";
let d: D | undefined;
console.log(new C(), d);
`,
  "default-value-named-type.ts": `import D, { C } from "./values";
let c: C | undefined;
console.log(D.tag, c);
`,
  "defaults-and-export-as.ts": `import { a, f } from "./values";
const { z = a } = {} as { z?: number };
const arr = [f][0];
export { a as default };
console.log(z, arr);
`,
  "deferred-uses.ts": `import { a } from "./values";
import { f } from "./values";
export const later = () => a + f();
export function typed(x: typeof a): void {}
`,
  "empty-and-inline-type.ts": `import {} from "./values";
import "./types";
import { type I } from "./types";
import { type T, a } from "./values_alias";
let i: I | undefined;
console.log(a, i);
`,
  "enum-initializers.ts": `import { NS, E } from "./values";
console.log(NS.v);
const enum G { A = E.B }
let e: E = 0;
console.log(G.A, e);
`,
  "heritage.ts": `import { C } from "./values";
import { C as C2, f } from "./values";
import { I } from "./types";
class X extends C implements I { x = 1; }
abstract class Y implements Pick<C2, "m"> { abstract m(): number; }
console.log(X, Y, typeof f);
`,
  "labels-and-namespaces.ts": `import { a, f } from "./values";
import { a as lbl, f as prop } from "./values";
namespace L { export const z = a; }
lbl: for (;;) { break lbl; }
const o = { prop: 1 };
console.log(L.z, o.prop, f === undefined);
`,
  "local-export-list.ts": `import { a, C, CE } from "./values";
import { I } from "./types";
import DI from "./types";
export { a, I, DI as Renamed };
export { C as Klass, CE };
`,
  "namespace.ts": `import * as V from "./values";
import * as W from "./values";
let c: V.C | undefined;
console.log(W.a, c);
`,
  "partial-default.ts": `import D, { a } from "./values";
import D2, { f } from "./values";
import D3, { C } from "./values";
console.log(a, D2);
let c: C | D3 | undefined;
`,
  "property-names.ts": `import { a, f } from "./values";
import { a as b } from "./values";
export const o = { a };
export const p = { f: 1, b() {}, a: 2 };
const { f: h } = { f: 1 };
console.log(h);
`,
  "reexports.ts": `export { a, C } from "./values";
export { I } from "./types";
export { I as J, T } from "./types";
export * from "./types";
export * as ns from "./types";
export { type I as K } from "./types";
export { C as TypeOnlyChain, a as chained, E as EnumType } from "./tchain";
export { default } from "./values";
export { default as DI } from "./types";
export { CE } from "./values";
`,
  "shadowed.ts": `import { a, f, C } from "./values";
function g(a: number): number { return a; }
let q: typeof f;
function h(): number { const C = 1; return C; }
console.log(g(1), h());
`,
  "tchain.ts": `export type { C } from "./values";
export { type E, a } from "./values";
`,
  "type-namespaces.ts": `import { OnlyTypes, NS } from "./values";
let p: OnlyTypes.P | NS.Inner | undefined;
export { OnlyTypes };
`,
  "type-positions.ts": `import { a, f, C, E } from "./values";
import { I } from "./types";
const x = 1 as unknown as I;
const y = { x: 1 } satisfies I;
const m = new Map<string, C>();
function id<V>(v: V): V { return v; }
id<typeof a>(1);
console.log(typeof f, a!, x, y, m, E.A as number);
`,
  "types-only.ts": `import { I, T } from "./types";
import DI from "./types";
import * as Ty from "./types";
const x: I = { x: 1 };
let t: T | undefined;
let d: DI | Ty.I | undefined;
console.log(x, t, d);
`,
  "types.ts": `export interface I { x: number }
export type T = string;
export default interface DI { d: number }
`,
  "unresolved.ts": `import { zz, yy } from "./missing";
import type { I } from "./types";
console.log(zz);
`,
  "unused.ts": `import { a, f } from "./values";
import D, * as V from "./values";
import D2, * as V2 from "./values";
console.log(V2.a);
let q: D2 | undefined;
`,
  "value-and-type.ts": `import { a, C } from "./values";
import { I } from "./types";
const x: I = { x: a };
let c: C | undefined;
console.log(x, c);
`,
  "values.ts": `export const a = 1;
export const key = "k" as const;
export const sym: unique symbol = Symbol("s");
export function f(): number { return 2; }
export class C { static s = 1; m(): number { return 3; } }
export default class D { static tag = "d"; }
export enum E { A, B }
export const enum CE { X = 1, Y }
export namespace NS { export const v = 1; export const enum Inner { Q = 3 } }
export namespace OnlyConst { export const enum K { Z = 9 } }
export namespace OnlyTypes { export interface P { p: number } }
`,
  "values_alias.ts": `export { a } from "./values";
export type T = number;
`,
  // A const enum exported through a local export list of the module that
  // imports it, and imported beside a name the importing file uses only as
  // a type. tsc drops both exports and inlines the member; the rewrite keeps
  // the name a value on both sides.
  "const-enum-reexport-e.ts": `export const enum E {
  A = 1,
}
export class C {
  x = 1;
}
`,
  "const-enum-reexport-mid.ts": `import { E, C } from "./const-enum-reexport-e";
export { E, C };
export type T = number;
`,
  "const-enum-reexport-main.ts": `import { C, type T, E } from "./const-enum-reexport-mid";
const t: T = 1;
const c: C | undefined = undefined;
console.log(E.A, t, c);
`,
  // The re-export chain one step longer: two const enums re-exported beside
  // a class and a function, imported in one clause that also holds a name
  // used only as a type.
  "chain-messages.ts": `export const enum Diagnostics {
  X_0_expected = 1000,
}
export const messageCodes = { X_0_expected: 1 };
`,
  "chain-locales.ts": `export const enum Locale {
  En = "en",
}
export const translations = { en: "en" };
`,
  "chain-diagnostics.ts": `import { Diagnostics } from "./chain-messages";
import { Locale } from "./chain-locales";
export { Diagnostics, Locale };
export type DiagnosticMessage = Diagnostics;
export class Diagnostic {
  code = 0;
}
export function messageCode(): number {
  return 1;
}
`,
  "chain-parser.ts": `import { Diagnostic, type DiagnosticMessage, Diagnostics, messageCode } from "./chain-diagnostics";
export function parse(text: string): Diagnostic | undefined {
  const message: DiagnosticMessage | undefined = undefined;
  if (text.length === 0) return undefined;
  console.log(Diagnostics.X_0_expected, messageCode(), message);
  return undefined;
}
`,
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "scriptc-import-elision-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

function host(server: Ts7TestServer, cwd: string): Ts7Host {
  return new Ts7Host(
    (options) =>
      new Ts7Api(
        new Ts7RpcClient(
          spawnTs7Wire(server.executable, [
            "--api",
            "--cwd",
            options.cwd,
            `--callbacks=${TS7_FILE_SYSTEM_CALLBACKS}`,
          ]),
        ),
        options.fs,
        options.collectTiming,
      ),
    { cwd },
  );
}

/** What the run-time module requests of a module text and the names it exports:
 * what survives type erasure. tsc may print an exported declaration as a
 * declaration and an export list, and adds or drops the empty `export {}`
 * marker freely, so exported names are compared as one set. A const enum
 * declaration counts as an export only where the dialect emits the enum
 * object (`preserveConstEnums`, `isolatedModules`). */
function requests(fileName: string, text: string, keepsConstEnums = false): string[] {
  const sf = ts5.createSourceFile(fileName, text, ts5.ScriptTarget.Latest, true);
  const out: string[] = [];
  const exported = new Set<string>();
  let hasDefault = false;
  for (const stmt of sf.statements) {
    const modifiers = ts5.canHaveModifiers(stmt) ? (ts5.getModifiers(stmt) ?? []) : [];
    if (modifiers.some((m) => m.kind === ts5.SyntaxKind.ExportKeyword)) {
      const ambient = modifiers.some((m) => m.kind === ts5.SyntaxKind.DeclareKeyword);
      const constEnum =
        !keepsConstEnums &&
        ts5.isEnumDeclaration(stmt) &&
        modifiers.some((m) => m.kind === ts5.SyntaxKind.ConstKeyword);
      if (modifiers.some((m) => m.kind === ts5.SyntaxKind.DefaultKeyword)) {
        if (!ts5.isInterfaceDeclaration(stmt)) hasDefault = true;
      } else if (ts5.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations)
          if (ts5.isIdentifier(d.name)) exported.add(d.name.text);
      } else if (
        !ambient &&
        !constEnum &&
        (ts5.isClassDeclaration(stmt) ||
          ts5.isFunctionDeclaration(stmt) ||
          ts5.isEnumDeclaration(stmt)) &&
        stmt.name !== undefined
      ) {
        exported.add(stmt.name.text);
      }
    }
    if (ts5.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      if (clause?.isTypeOnly === true) continue;
      const names: string[] = [];
      if (clause?.name !== undefined) names.push(`default as ${clause.name.text}`);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts5.isNamespaceImport(bindings))
        names.push(`* as ${bindings.name.text}`);
      if (bindings !== undefined && ts5.isNamedImports(bindings))
        for (const e of bindings.elements)
          if (!e.isTypeOnly) names.push(`${(e.propertyName ?? e.name).text} as ${e.name.text}`);
      const specifier = (stmt.moduleSpecifier as ts5.StringLiteral).text;
      out.push(`import ${specifier} {${names.sort().join(", ")}}`);
    } else if (ts5.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      const specifier =
        stmt.moduleSpecifier === undefined ? "" : (stmt.moduleSpecifier as ts5.StringLiteral).text;
      if (stmt.exportClause === undefined) out.push(`export * ${specifier}`);
      else if (ts5.isNamespaceExport(stmt.exportClause))
        out.push(`export * as ${stmt.exportClause.name.text} ${specifier}`);
      else {
        const names = stmt.exportClause.elements
          .filter((e) => !e.isTypeOnly)
          .map((e) => `${(e.propertyName ?? e.name).text} as ${e.name.text}`);
        if (specifier === "") {
          for (const name of names)
            if (name.endsWith(" as default")) hasDefault = true;
            else exported.add(name);
        } else {
          out.push(`export ${specifier} {${names.sort().join(", ")}}`);
        }
      }
    } else if (ts5.isExportAssignment(stmt)) {
      if (stmt.isExportEquals) out.push("export =");
      else hasDefault = true;
    } else if (ts5.isImportEqualsDeclaration(stmt)) {
      if (!stmt.isTypeOnly && ts5.isExternalModuleReference(stmt.moduleReference))
        out.push(
          `require ${(stmt.moduleReference.expression as ts5.StringLiteral).text} ${stmt.name.text}`,
        );
    } else if (ts5.isVariableStatement(stmt)) {
      // tsc's CommonJS output of `import x = require("m")`.
      for (const d of stmt.declarationList.declarations) {
        const init = d.initializer;
        if (
          init !== undefined &&
          ts5.isCallExpression(init) &&
          ts5.isIdentifier(init.expression) &&
          init.expression.text === "require" &&
          init.arguments[0] !== undefined &&
          ts5.isStringLiteral(init.arguments[0]) &&
          ts5.isIdentifier(d.name)
        )
          out.push(`require ${init.arguments[0].text} ${d.name.text}`);
      }
    }
  }
  if (hasDefault) out.push("export default");
  for (const name of exported)
    out.push(`exported ${name.includes(" as ") ? name : `${name} as ${name}`}`);
  return out.sort();
}

/** `requests` spells a kept specifier `<original> as <exported>`; the last
 * name is the exported one. */
function exportedNameOf(entry: string): string {
  return entry.slice(entry.lastIndexOf(" as ") + " as ".length);
}

/** What tsc 5.9 emits for every case, as requests. */
function tscRequests(root: string, options: ts5.CompilerOptions): Map<string, string[]> {
  const names = Object.keys(FILES).map((name) => join(root, name));
  const program = ts5.createProgram(names, {
    strict: true,
    target: ts5.ScriptTarget.ES2022,
    module: ts5.ModuleKind.ESNext,
    moduleResolution: ts5.ModuleResolutionKind.Bundler,
    experimentalDecorators: false,
    ...options,
  });
  const out = new Map<string, string[]>();
  for (const name of names) {
    program.emit(program.getSourceFile(name), (outName, text) => {
      if (outName.endsWith(".js")) out.set(name, requests(outName, text));
    });
  }
  return out;
}

/** `inlinedOnly`: the cases whose import tsc drops because it resolves every
 * use at compile time (const enum members, an import alias used only in
 * types), which the rewrite keeps and reports. */
const DIALECTS: {
  label: string;
  tsc: ts5.CompilerOptions;
  scriptc: Record<string, unknown>;
  inlinedOnly: string[];
}[] = [
  {
    label: "default",
    tsc: {},
    scriptc: {},
    inlinedOnly: [
      "chain-diagnostics.ts",
      "chain-diagnostics.ts",
      "const-enum-reexport-main.ts",
      "const-enums.ts",
      "const-enums.ts",
      "type-alias-of-import.ts",
    ],
  },
  {
    label: "isolatedModules",
    tsc: { isolatedModules: true },
    scriptc: { isolatedModules: true },
    inlinedOnly: ["type-alias-of-import.ts"],
  },
  {
    label: "preserveConstEnums",
    tsc: { preserveConstEnums: true },
    scriptc: { preserveConstEnums: true },
    inlinedOnly: [
      "const-enum-reexport-main.ts",
      "const-enums.ts",
      "const-enums.ts",
      "type-alias-of-import.ts",
    ],
  },
];

describe.each(ts7TestServers())("import elision ($name)", (server) => {
  test.each(DIALECTS)("keeps the imports and exports tsc keeps ($label)", (dialect) => {
    const root = project(FILES);
    const expected = tscRequests(root, dialect.tsc);
    const programHost = host(server, root);
    try {
      const names = Object.keys(FILES).map((name) => join(root, name));
      // The module every case imports from has no imports of its own, and
      // its namespaces are printed or not by rules that are not the subject.
      expected.delete(join(root, "values.ts"));
      const program = programHost.createProgram(names, {
        strict: true,
        target: "es2022" as never,
        module: "esnext" as never,
        moduleResolution: "bundler" as never,
        noEmit: true,
        ...dialect.scriptc,
      });
      const options = importElisionOptions(dialect.scriptc)!;
      const keepsConstEnums =
        dialect.scriptc["preserveConstEnums"] === true ||
        dialect.scriptc["isolatedModules"] === true;
      const elision = elideProgramImports(program, () => options);
      const elisions = elision.texts;
      const actual = new Map<string, string[]>();
      for (const name of names) {
        if (!expected.has(name)) continue;
        const source = program.getSourceFile(name)!;
        const original = source.text;
        const rewritten = elisions.get(name) ?? original;
        const elision = elideImports(program, source, options);
        // A binding kept for a use tsc inlines is the one difference from
        // tsc's output: compare without those bindings, and without the
        // value exports kept for the same reason.
        const inlined = new Set(elision?.inlined ?? []);
        const inlinedExports = new Set(elision?.inlinedExports ?? []);
        actual.set(
          name,
          requests(name, rewritten, keepsConstEnums)
            .map((request) =>
              request.replace(/\{(.*)\}$/, (_, list: string) => {
                const kept = list.split(", ").filter((binding) => {
                  const local = binding.split(" as ")[1];
                  return local === undefined || !inlined.has(local);
                });
                return `{${kept.join(", ")}}`;
              }),
            )
            .filter((request) => inlined.size === 0 || !/^import \S+ \{\}$/.test(request))
            .map((request) =>
              request.replace(/^export (\S+) \{(.*)\}$/, (_, specifier: string, list: string) => {
                const kept = list
                  .split(", ")
                  .filter((binding) => !inlinedExports.has(exportedNameOf(binding)));
                return kept.length === 0 ? "" : `export ${specifier} {${kept.join(", ")}}`;
              }),
            )
            .filter((request) => request !== "")
            .filter(
              (request) =>
                !(request.startsWith("exported ") && inlinedExports.has(exportedNameOf(request))),
            ),
        );
        // Every offset of the file as written survives: characters are
        // kept or blanked, never moved, and additions follow the text.
        expect(rewritten.length).toBeGreaterThanOrEqual(original.length);
        for (let i = 0; i < original.length; i++) {
          if (rewritten[i] !== original[i]) expect(rewritten[i]).toBe(" ");
        }
      }
      expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
      // The table holds cases of both kinds.
      expect(elisions.size).toBeGreaterThan(15);
      expect(elisions.has(join(root, "default-export-value.ts"))).toBe(false);
      expect(elision.inlinedOnly.map((kept) => kept.file.slice(root.length + 1)).sort()).toEqual(
        dialect.inlinedOnly,
      );
      program.dispose();
    } finally {
      programHost.close();
    }
  });

  function rewrite(
    files: Record<string, string>,
    entry: string,
    options: Partial<ImportElisionOptions>,
    compilerOptions: Record<string, unknown> = {},
  ): string | null {
    return elide(files, entry, options, compilerOptions)?.text ?? null;
  }

  function elide(
    files: Record<string, string>,
    entry: string,
    options: Partial<ImportElisionOptions>,
    compilerOptions: Record<string, unknown> = {},
  ): ImportElision | null {
    const root = project(files);
    const programHost = host(server, root);
    try {
      const program = programHost.createProgram(
        Object.keys(files).map((name) => join(root, name)),
        { strict: true, noEmit: true, ...compilerOptions },
      );
      const elision = elideImports(program, program.getSourceFile(join(root, entry))!, {
        isolatedModules: false,
        preserveConstEnums: false,
        preserveImportEdges: false,
        preserveValueImports: false,
        ...options,
      });
      program.dispose();
      return elision;
    } finally {
      programHost.close();
    }
  }

  const VALUES = "export const a = 1;\nexport interface I { x: number }\n";

  test("a dropped binding is blanked in place and declared type-only after the text", () => {
    expect(
      rewrite(
        {
          "values.ts": VALUES,
          "main.ts": 'import { a, I } from "./values";\nconst x: I = { x: a };\nconsole.log(x);\n',
        },
        "main.ts",
        {},
      ),
    ).toBe(
      'import { a,   } from "./values";\nconst x: I = { x: a };\nconsole.log(x);\nimport type { I } from "./values";\n',
    );
  });

  test("a module that loses its last import keeps its format, as in tsc's output", () => {
    expect(
      rewrite(
        {
          "values.ts": VALUES,
          "main.ts": 'import { I } from "./values";\nconst x: I = { x: 1 };\nconsole.log(x);\n',
        },
        "main.ts",
        {},
      ),
    ).toBe(
      `${" ".repeat('import { I } from "./values";'.length)}\nconst x: I = { x: 1 };\nconsole.log(x);\nimport type { I } from "./values";\nexport {};\n`,
    );
  });

  test("import = require is kept only where the file uses the module as a value", () => {
    const files = {
      "values.ts": VALUES,
      "main.ts":
        'import V = require("./values");\nimport T = require("./values");\nlet i: T.I | undefined;\nconsole.log(V.a, i);\n',
    };
    expect(rewrite(files, "main.ts", {}, { module: "commonjs" })).toBe(
      `import V = require("./values");\n${" ".repeat('import T = require("./values");'.length)}\nlet i: T.I | undefined;\nconsole.log(V.a, i);\nimport type T = require("./values");\n`,
    );
  });

  test("importsNotUsedAsValues: preserve keeps the module load where the import stands", () => {
    expect(
      rewrite(
        {
          "values.ts": VALUES,
          "main.ts": 'import { I } from "./values";\nconst x: I = { x: 1 };\nconsole.log(x);\n',
        },
        "main.ts",
        { preserveImportEdges: true },
      ),
    ).toBe(
      `import ${" ".repeat("{ I } from ".length)}"./values";\nconst x: I = { x: 1 };\nconsole.log(x);\nimport type { I } from "./values";\n`,
    );
  });

  test("preserveValueImports keeps an unused import of a value", () => {
    const files = {
      "values.ts": VALUES,
      "main.ts": 'import { a, I } from "./values";\nconst x: I = { x: 1 };\nconsole.log(x);\n',
    };
    expect(rewrite(files, "main.ts", { preserveValueImports: true })).toBe(
      'import { a,   } from "./values";\nconst x: I = { x: 1 };\nconsole.log(x);\nimport type { I } from "./values";\n',
    );
    expect(rewrite(files, "main.ts", {})).toBe(
      `${" ".repeat('import { a, I } from "./values";'.length)}\nconst x: I = { x: 1 };\nconsole.log(x);\nimport type { a, I } from "./values";\nexport {};\n`,
    );
  });

  test("an import used only for inlined const enum members is kept and reported", () => {
    const files = {
      "levels.ts": "export const enum Level { Low = 1, High = 2 }\n",
      "main.ts": 'import { Level } from "./levels";\nconsole.log(Level.High);\n',
    };
    // tsc inlines Level.High and drops the import; the use needs the
    // binding as a value here, so the import stays and the build says so.
    expect(elide(files, "main.ts", {})).toEqual({
      text: null,
      declarations: 0,
      bindings: 0,
      inlined: ["Level"],
      inlinedExports: [],
      inlinedOnly: [
        { start: 0, end: 'import { Level } from "./levels";'.length, specifier: '"./levels"' },
      ],
    });
    // With isolatedModules tsc keeps the import too.
    expect(elide(files, "main.ts", { isolatedModules: true, preserveConstEnums: true })).toBeNull();
  });

  test("a value use of a const enum re-exported through a local export list keeps the export", () => {
    // tsc drops `export { Diagnostics, Locale }` and the imports behind it,
    // because its output has no value for either name. Here the name stays a
    // value, so the import that uses Diagnostics as a value still resolves.
    const files = {
      "messages.ts": "export const enum Diagnostics {\n  X_0_expected = 1000,\n}\n",
      "locales.ts": 'export const enum Locale {\n  En = "en",\n}\n',
      "diagnostics.ts":
        'import { Diagnostics } from "./messages";\nimport { Locale } from "./locales";\nexport { Diagnostics, Locale };\n',
      "parser.ts":
        'import { Diagnostic, Diagnostics } from "./diagnostics";\nconsole.log(Diagnostics.X_0_expected, undefined as Diagnostic | undefined);\n',
    };
    const exportSide = elide(files, "diagnostics.ts", {});
    expect(exportSide?.text).toBeNull();
    expect(exportSide?.inlinedExports).toEqual(["Diagnostics", "Locale"]);
    expect(exportSide?.inlined).toEqual(["Diagnostics", "Locale"]);
    const useSide = elide(files, "parser.ts", {});
    expect(useSide?.inlined).toEqual(["Diagnostics"]);
    expect(useSide?.text).toMatch(/import \{[^}]*\bDiagnostics\b[^}]*\} from "\.\/diagnostics"/);
  });

  test("a 13-line program that uses a re-exported const enum as a value compiles", () => {
    // The const enum travels from the module that declares it, through a
    // module that re-exports it, to a file that uses a member as a value.
    // Eliding the export on the way leaves the use without a value.
    const files = {
      "tsconfig.json": `{
  "compilerOptions": {
    "module": "nodenext",
    "target": "esnext",
    "strict": true,
    "noEmit": true
  },
  "include": ["**/*.ts"]
}
`,
      "e.ts": "export const enum E {\n  A = 1,\n}\nexport class C {\n  x = 1;\n}\n",
      "mid.ts": "import { E, C } from './e.js';\nexport { E, C };\nexport type T = number;\n",
      "main.ts":
        "import { C, type T, E } from './mid.js';\nconst t: T = 1;\nconst c: C | undefined = undefined;\nconsole.log(E.A, t, c);\n",
    };
    const root = project(files);
    // The load refuses the program when a value use of a kept name has no
    // value in the rewritten sources; it must load.
    const loaded = loadProgram(join(root, "main.ts"));
    try {
      // The use of E keeps the import, and the export that names it stays a
      // value export.
      const main = loaded.program.getSourceFile(join(root, "main.ts"))!;
      expect(main.text).toMatch(/import \{[^}]*\bE\b[^}]*\} from ['"]\.\/mid\.js['"]/);
      expect(loaded.program.getSourceFile(join(root, "mid.ts"))!.text).toContain(
        "export { E, C };",
      );
    } finally {
      loaded.dispose();
    }
  });

  test("a file whose only imports bind nothing loses them, as in tsc's output", () => {
    const files = {
      "values.ts": VALUES,
      "main.ts":
        'import {} from "./values";\nimport { type I } from "./values";\nconst x: I = { x: 1 };\nconsole.log(x);\n',
    };
    expect(rewrite(files, "main.ts", {})).toBe(
      `${" ".repeat('import {} from "./values";'.length)}\n${" ".repeat('import { type I } from "./values";'.length)}\nconst x: I = { x: 1 };\nconsole.log(x);\nimport type { I } from "./values";\nexport {};\n`,
    );
  });

  test("an import alias inside a namespace keeps the import it reads when it is used", () => {
    const files = {
      "values.ts": "export function helper(): number { return 1; }\nexport const spare = 2;\n",
      "main.ts":
        'import * as lib from "./values";\nimport * as other from "./values";\nnamespace N {\n  import helper = lib.helper;\n  import unused = other.spare;\n  export const r = helper();\n}\nconsole.log(N.r);\n',
    };
    expect(rewrite(files, "main.ts", {})).toBe(
      `import * as lib from "./values";\n${" ".repeat('import * as other from "./values";'.length)}\nnamespace N {\n  import helper = lib.helper;\n  ${" ".repeat("import unused = other.spare;".length)}\n  export const r = helper();\n}\nconsole.log(N.r);\nimport type * as other from "./values";\nexport {};\n`,
    );
  });

  test("the checker is asked about a whole program's imports in one request, not file by file", () => {
    // Each module imports from two modules, uses a value of each, and one
    // in three imports a type without `type`.
    const modules = 36;
    const files: Record<string, string> = {
      "values.ts": VALUES,
      "more.ts": "export function grow(n: number): number { return n + 1; }\n",
    };
    for (let i = 0; i < modules; i++) {
      files[`m${i}.ts`] =
        `import { a${i % 3 === 0 ? ", I" : ""} } from "./values";\n` +
        `import { grow } from "./more";\n` +
        `export const v${i}${i % 3 === 0 ? ": I" : ""} = { x: grow(a) };\n`;
    }
    const root = project(files);
    const programHost = host(server, root);
    try {
      const program = programHost.createProgram(
        Object.keys(files).map((name) => join(root, name)),
        { strict: true, noEmit: true },
      );
      const symbols = vi.spyOn(SemanticChecker.prototype, "getSymbolAtLocation");
      try {
        const elision = elideProgramImports(program, () => importElisionOptions({})!);
        expect(elision.texts.size).toBe(modules / 3);
        // One batch holds every module's binding names, their uses and the
        // module specifiers behind which a type-only declaration is looked
        // for. A request per file, or per import declaration, is what made
        // the decision cost a second per thousand files on every load.
        expect(symbols.mock.calls.length).toBe(1);
        expect(Array.isArray(symbols.mock.calls[0]![0])).toBe(true);
      } finally {
        symbols.mockRestore();
      }
      program.dispose();
    } finally {
      programHost.close();
    }
  });

  test("a file with nothing to drop is left alone", () => {
    expect(
      rewrite(
        { "values.ts": VALUES, "main.ts": 'import { a } from "./values";\nconsole.log(a);\n' },
        "main.ts",
        {},
      ),
    ).toBeNull();
  });
});

test("verbatimModuleSyntax selects Node's rule; the removed options are still read", () => {
  expect(importElisionOptions({ verbatimModuleSyntax: true })).toBeNull();
  expect(importElisionOptions({})).toEqual({
    isolatedModules: false,
    preserveConstEnums: false,
    preserveImportEdges: false,
    preserveValueImports: false,
  });
  expect(importElisionOptions({ isolatedModules: true })?.preserveConstEnums).toBe(true);
  expect(importElisionOptions({ importsNotUsedAsValues: "preserve" })?.preserveImportEdges).toBe(
    true,
  );
  expect(importElisionOptions({ importsNotUsedAsValues: "remove" })?.preserveImportEdges).toBe(
    false,
  );
  expect(importElisionOptions({ preserveValueImports: true })?.preserveValueImports).toBe(true);
});
