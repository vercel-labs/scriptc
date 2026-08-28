/* The resolver parity sweep: scriptc's own resolver (frontend/resolve.ts —
 * the TS7 world's replacement for ts.resolveModuleName /
 * ts.resolveTypeReferenceDirective) must answer EXACTLY like 5.9.3 under
 * scriptc's fixed options, for every module specifier written anywhere in
 * the test tree — the whole differential corpus, the diagnostics fixtures,
 * and the npm/strictness/node-types fixture trees. Frontend-only and
 * program-free (a parse per file, fs probes per specifier), so the full
 * sweep stays cheap enough to run in the default lane. */

import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts5 from "typescript5";
import { expect, test } from "vitest";
import {
  clearResolveCaches,
  projectDtsRuntimeSibling,
  resolveBareModule,
  resolveProjectImport,
  resolveRelativeModule,
  resolveTypeDirective,
} from "../../src/frontend/resolve.js";
import { isRelativeSpecifier } from "../../src/frontend/workspace-registry.js";
import { options5 } from "./harness.js";

const repoRoot = join(import.meta.dirname, "../../../..");
const OPTS = options5();

/** Every source file under tests/ that scriptc's preflight could scan —
 * node_modules excluded (preflight never collects edges inside packages;
 * npm.ts's runtime resolver owns that world and has its own suite). */
function sweepFiles(): string[] {
  const roots = [
    "tests/corpus",
    "tests/diagnostics",
    "tests/coverage-fixtures",
    "tests/fixtures",
    "tests/deadstrip",
  ];
  const files: string[] = [];
  for (const root of roots) {
    for (const ext of ["ts", "tsx", "js", "mjs", "cjs", "jsx"]) {
      files.push(
        ...globSync(join(repoRoot, root, `**/*.${ext}`)).filter(
          (f) => !f.includes("/node_modules/") && !f.includes("/store/"),
        ),
      );
    }
  }
  return files.sort();
}

/** All module specifiers of one file: import/export declarations, dynamic
 * import("lit"), require("lit") — the same shapes preflight edges. The walk
 * uses an EXPLICIT stack: the sweep sees the deep-nesting-preflight fixture
 * (a ~7000-term binary chain — 5.9.3's parser trampolines it, but a
 * recursive forEachChild visit would overflow exactly like the compiler
 * walks this fixture exists to pin). */
function specifiersOf(file: string): string[] {
  const sf = ts5.createSourceFile(file, readFileSync(file, "utf8"), ts5.ScriptTarget.Latest, false);
  const out = new Set<string>();
  const stack: ts5.Node[] = [sf];
  const children: ts5.Node[] = [];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (
      (ts5.isImportDeclaration(n) || ts5.isExportDeclaration(n)) &&
      n.moduleSpecifier !== undefined &&
      ts5.isStringLiteral(n.moduleSpecifier)
    ) {
      out.add(n.moduleSpecifier.text);
    } else if (ts5.isCallExpression(n)) {
      const arg = n.arguments[0];
      const isImport = n.expression.kind === ts5.SyntaxKind.ImportKeyword;
      const isRequire =
        ts5.isIdentifier(n.expression) && n.expression.text === "require" && n.arguments.length === 1;
      if ((isImport || isRequire) && arg !== undefined && ts5.isStringLiteralLike(arg)) {
        out.add(arg.text);
      }
    }
    children.length = 0;
    ts5.forEachChild(n, (c) => {
      children.push(c);
    });
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return [...out];
}

test("relative and bare specifiers across the whole test tree resolve identically", () => {
  clearResolveCaches();
  const files = sweepFiles();
  expect(files.length).toBeGreaterThan(500);
  let relative = 0;
  let bare = 0;
  const failures: string[] = [];
  for (const file of files) {
    for (const spec of specifiersOf(file)) {
      const reference = ts5.resolveModuleName(spec, file, OPTS, ts5.sys).resolvedModule ?? null;
      // Bare '.' and '..' are the relative directory forms (SEMANTICS 362)
      // — ts5 resolves them relative too, so they ride the relative arm.
      if (isRelativeSpecifier(spec)) {
        relative++;
        const ours = resolveRelativeModule(file, spec);
        // The ONE deliberate relative-resolution delta: a PROJECT
        // declaration twin answers its runtime sibling (Node loads the
        // JS; resolve.ts's projectDtsRuntimeSibling) where 5.9.3 answers
        // the .d.ts — parity holds over the sibling-mapped answer.
        const theirsRaw = reference?.resolvedFileName ?? null;
        const theirs = theirsRaw !== null ? (projectDtsRuntimeSibling(theirsRaw) ?? theirsRaw) : null;
        if (ours !== theirs) {
          failures.push(`${file} '${spec}': ours=${ours} ts5=${theirs}`);
        }
        continue;
      }
      if (spec.startsWith("node:")) continue; // never a resolver question
      // The ONE pinned 5.9.3 delta: "#/"-prefixed imports-field aliases.
      // 5.9.3 refuses them outright; current Node (probed on v24.15.0) and
      // the embedded tsgo both resolve them through "#/*" pattern keys, and
      // the resolver follows Node — corpus 2124 pins the behavior
      // differentially, so parity has nothing to check here.
      if (spec.startsWith("#/")) continue;
      bare++;
      // PROJECT imports (#alias / self-name): ts5's NON-external answers
      // for bare specifiers are exactly the package.json-mediated
      // resolutions inside the project — resolveProjectImport must agree.
      const oursProj = resolveProjectImport(file, spec);
      const theirsProj =
        reference && !reference.isExternalLibraryImport ? reference.resolvedFileName : null;
      if (oursProj !== theirsProj) {
        failures.push(`${file} '${spec}' (project): ours=${oursProj} ts5=${theirsProj}`);
      }
      const ours = resolveBareModule(file, spec);
      const theirs = reference && reference.isExternalLibraryImport ? reference : null;
      const oursFile = ours?.typesFile ?? null;
      const theirsFile = theirs?.resolvedFileName ?? null;
      if (oursFile !== theirsFile) {
        failures.push(`${file} '${spec}': ours=${oursFile} ts5=${theirsFile}`);
        continue;
      }
      if (theirs !== null && ours !== null) {
        const theirName = theirs.packageId?.name;
        if (theirName !== undefined && ours.packageName !== theirName) {
          failures.push(`${file} '${spec}': packageName ours=${ours.packageName} ts5=${theirName}`);
        }
        if (ours.version !== theirs.packageId?.version) {
          failures.push(
            `${file} '${spec}': version ours=${ours.version} ts5=${theirs.packageId?.version}`,
          );
        }
      }
    }
  }
  expect(failures, failures.slice(0, 20).join("\n")).toEqual([]);
  expect(relative).toBeGreaterThan(50);
  expect(bare).toBeGreaterThan(20);
});

test("synthetic edge shapes: extension substitution, directories, exports maps, @types", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-resolve-parity-"));
  const write = (rel: string, text = "export const x = 1;\n"): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  // Relative shapes: every substitution family, shadowing pairs, JSON,
  // directories with and without package.json fields.
  write("src/from.ts");
  write("src/a.ts");
  write("src/b.js");
  write("src/both.ts");
  write("src/both.js");
  write("src/decl.d.ts");
  write("src/m.mts");
  write("src/mj.mjs");
  write("src/c.cts");
  write("src/cj.cjs");
  write("src/data.json", "{\"k\":1}\n");
  write("src/typedjson.d.json.ts");
  write("src/typedjson.json", "{}\n");
  write("src/dir/index.ts");
  write("src/jsdir/index.js");
  write("src/pkgdir/package.json", JSON.stringify({ main: "./lib/entry.js" }));
  write("src/pkgdir/lib/entry.js");
  write("src/pkgdir/lib/entry.ts");
  write("src/typesdir/package.json", JSON.stringify({ types: "./t.d.ts", main: "./m.js" }));
  write("src/typesdir/t.d.ts");
  write("src/typesdir/m.js");
  // node_modules shapes: main-substitution, exports conditions, subpaths,
  // patterns, @types fallback (plain and scoped), versionless packages.
  const nm = "src/node_modules";
  write(`${nm}/plain/package.json`, JSON.stringify({ name: "plain", version: "1.2.3", main: "index.js" }));
  write(`${nm}/plain/index.d.ts`);
  write(`${nm}/plain/index.js`);
  write(`${nm}/plain/sub.d.ts`);
  write(`${nm}/exportsy/package.json`, JSON.stringify({
    name: "exportsy",
    version: "2.0.0",
    exports: {
      ".": { types: "./dist/root.d.ts", import: "./dist/root.mjs", require: "./dist/root.cjs" },
      "./deep/*": { types: "./dist/deep/*.d.ts" },
      "./onlyjs": "./dist/onlyjs.js",
    },
  }));
  write(`${nm}/exportsy/dist/root.d.ts`);
  write(`${nm}/exportsy/dist/deep/thing.d.ts`);
  write(`${nm}/exportsy/dist/onlyjs.js`);
  write(`${nm}/exportsy/dist/onlyjs.d.ts`);
  write(`${nm}/untyped/package.json`, JSON.stringify({ name: "untyped", version: "0.1.0", main: "index.js" }));
  write(`${nm}/untyped/index.js`);
  write(`${nm}/@types/untyped/package.json`, JSON.stringify({ name: "@types/untyped", version: "0.1.9", types: "index.d.ts" }));
  write(`${nm}/@types/untyped/index.d.ts`);
  write(`${nm}/@scoped/thing/package.json`, JSON.stringify({ name: "@scoped/thing", version: "3.0.0", main: "./x.js" }));
  write(`${nm}/@scoped/thing/x.js`);
  write(`${nm}/@types/scoped__thing/package.json`, JSON.stringify({ name: "@types/scoped__thing", version: "3.0.1", types: "main.d.ts" }));
  write(`${nm}/@types/scoped__thing/main.d.ts`);
  write(`${nm}/noversion/package.json`, JSON.stringify({ name: "noversion", types: "index.d.ts" }));
  write(`${nm}/noversion/index.d.ts`);
  // Nested package.json subpaths (the @restart/hooks/useMergedRefs shape):
  // a subdirectory redirecting through its OWN package.json's types/main.
  write(`${nm}/nested/package.json`, JSON.stringify({ name: "nested", version: "1.0.0", main: "index.js" }));
  write(`${nm}/nested/index.d.ts`);
  write(`${nm}/nested/index.js`);
  write(`${nm}/nested/sub/package.json`, JSON.stringify({ main: "../lib/s.js", module: "../esm/s.js", types: "../esm/s.d.ts" }));
  write(`${nm}/nested/lib/s.js`);
  write(`${nm}/nested/esm/s.d.ts`);
  write(`${nm}/nested/esm/s.js`);
  write(`${nm}/nested/jsub/package.json`, JSON.stringify({ main: "../lib/j.js" }));
  write(`${nm}/nested/lib/j.js`);

  const from = join(dir, "src/from.ts");
  const specs = [
    "./a", "./a.js", "./a.ts", "./b", "./b.js", "./both", "./both.js", "./both.ts",
    "./decl", "./decl.js", "./m", "./m.mjs", "./mj.mjs", "./mj", "./c.cjs", "./cj.cjs", "./cj",
    "./data.json", "./typedjson.json", "./dir", "./jsdir", "./pkgdir", "./typesdir",
    "./missing", "./missing.js", "./missing.json", "./a.jsx", "./a.tsx",
    "plain", "plain/sub", "plain/sub.js", "plain/missing",
    "exportsy", "exportsy/deep/thing", "exportsy/onlyjs", "exportsy/nope",
    "untyped", "@scoped/thing", "@scoped/thing/x", "noversion", "ghost-package",
    "nested/sub", "nested/jsub", "nested/none",
  ];
  const failures: string[] = [];
  clearResolveCaches();
  for (const spec of specs) {
    const reference = ts5.resolveModuleName(spec, from, OPTS, ts5.sys).resolvedModule ?? null;
    if (spec.startsWith("./")) {
      const ours = resolveRelativeModule(from, spec);
      const theirs = reference?.resolvedFileName ?? null;
      if (ours !== theirs) failures.push(`'${spec}': ours=${ours} ts5=${theirs}`);
      continue;
    }
    const ours = resolveBareModule(from, spec);
    const theirs = reference && reference.isExternalLibraryImport ? reference : null;
    if ((ours?.typesFile ?? null) !== (theirs?.resolvedFileName ?? null)) {
      failures.push(`'${spec}': ours=${ours?.typesFile ?? null} ts5=${theirs?.resolvedFileName ?? null}`);
      continue;
    }
    if (ours && theirs) {
      const wantName = theirs.packageId?.name ?? (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
      if (ours.packageName !== wantName) failures.push(`'${spec}': packageName ours=${ours.packageName} ts5=${wantName}`);
      if (ours.version !== theirs.packageId?.version) failures.push(`'${spec}': version ours=${ours.version} ts5=${theirs.packageId?.version}`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  clearResolveCaches();
  expect(failures, failures.join("\n")).toEqual([]);
});

test("synthetic project imports: the imports field and self-name exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-resolve-projimp-"));
  const write = (rel: string, text = "export const x = 1;\n"): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  write(
    "package.json",
    JSON.stringify({
      name: "pkg",
      type: "module",
      imports: {
        "#cjs": "./index.cjs",
        "#mjs": "./index.mjs",
        "#type": "./index.js",
        "#direct": "./direct.ts",
        "#wild/*": "./src/*",
        "#cond": { types: "./cond.d.ts", default: "./cond.js" },
        "#dead": "./nowhere.js",
      },
      exports: {
        ".": "./index.js",
        "./cjs": "./index.cjs",
        "./sub/*": "./src/*",
        "./srcmap/*.ts": { source: "./*.ts", default: "./*.js" },
      },
    }),
  );
  write("index.ts");
  write("index.cts");
  write("index.mts");
  write("direct.ts");
  write("src/foo.ts");
  write("cond.d.ts", "export declare const x: number;\n");
  write("cond.js");
  write("foo.ts");
  write("deep/inner.ts");
  const froms = [join(dir, "index.ts"), join(dir, "deep/inner.ts")];
  const specs = [
    // imports field: exact keys with extension substitution, direct .ts
    // targets, wildcards, condition objects, dead targets, and the Node
    // validity rule ("#" and "#/" never resolve).
    "#cjs", "#mjs", "#type", "#direct", "#wild/foo.js", "#wild/foo.ts", "#cond", "#dead",
    "#missing", "#", "#/foo.js",
    // self-name through exports: root, subpaths, wildcards, misses, and a
    // name that is NOT the package's ("other" walks node_modules instead).
    "pkg", "pkg/cjs", "pkg/sub/foo.js", "pkg/srcmap/foo.ts", "pkg/nope", "other",
  ];
  const failures: string[] = [];
  clearResolveCaches();
  for (const from of froms) {
    for (const spec of specs) {
      const reference = ts5.resolveModuleName(spec, from, OPTS, ts5.sys).resolvedModule ?? null;
      const theirs =
        reference && !reference.isExternalLibraryImport ? reference.resolvedFileName : null;
      const ours = resolveProjectImport(from, spec);
      if (ours !== theirs) failures.push(`${from} '${spec}': ours=${ours} ts5=${theirs}`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  clearResolveCaches();
  expect(failures, failures.join("\n")).toEqual([]);
});

test("the 'node' type directive resolves identically from every fixture anchor", () => {
  const anchors = [
    join(repoRoot, "tests/fixtures/node-types/argv-env.ts"),
    join(repoRoot, "tests/corpus/001-hello.ts"),
    join(repoRoot, "packages/compiler/src/index.ts"),
    "/tmp/scriptc-nowhere/entry.ts",
  ];
  for (const anchor of anchors) {
    const theirs =
      ts5.resolveTypeReferenceDirective("node", anchor, { ...OPTS, typeRoots: [] }, ts5.sys)
        .resolvedTypeReferenceDirective?.resolvedFileName ?? null;
    const ours = resolveTypeDirective("node", anchor);
    expect(ours, anchor).toBe(theirs);
  }
});
