/** Filesystem side of npm-static-type-exports.ts: finds each opted-in
 * package's declaration entry and runtime entry, copies the declaration
 * files the entry reaches, and builds the runtime entry's typedefs. */
import { dirname, relative, resolve as resolvePath } from "node:path";
import { trackedFileExists } from "./input-tracker.js";
import { packageSourceText } from "./type-patches/layer.js";
import { resolveBareModule } from "./resolve.js";
import { isJsSourceFileName } from "./tsc-codes.js";
import { NPM_STATIC_TYPES_SUFFIX } from "./npm-static.js";
import type { FrontendServices } from "./services.js";
import * as ts from "./ts7/syntax.js";
import {
  npmStaticDeclarationCopy,
  npmStaticDeclarationExports,
  npmStaticDeclarationSpecifiers,
  npmStaticTypedefBlock,
  type NpmStaticDeclarationExports,
  type NpmStaticTypeDeclaration,
} from "./npm-static-type-exports.js";

export interface NpmStaticTypeExportPlan {
  /** Copies of the declaration files, by copy path. */
  copies: Map<string, string>;
  /** The typedef block to append, by runtime entry (forward slashes). */
  typedefs: Map<string, string>;
}

/** The copy path of a declaration file. */
function copyPathOf(declarationFile: string): string {
  return declarationFile.replace(/\.d\.ts$/, NPM_STATIC_TYPES_SUFFIX);
}

/** The declaration file a relative specifier names from `fromFile`, or null. */
function declarationTargetOf(fromFile: string, specifier: string): string | null {
  const base = resolvePath(dirname(fromFile), specifier);
  const candidates = [
    `${base}.d.ts`,
    `${base.replace(/\.(c|m)?js$/, "")}.d.ts`,
    resolvePath(base, "index.d.ts"),
  ];
  for (const candidate of candidates) if (trackedFileExists(candidate)) return candidate;
  return null;
}

/** A specifier for `target` from `fromFile`'s directory, without `.d.ts`. */
function specifierFor(fromFile: string, target: string): string {
  const rel = relative(dirname(fromFile), target)
    .split("\\")
    .join("/")
    .replace(/\.d\.ts$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The names the runtime JavaScript declares as types itself: classes,
 * JSDoc typedefs and callbacks, and `@enum` constants. */
function runtimeTypeNames(services: FrontendServices, file: string, text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/@(?:typedef|callback)\s+(?:\{[^}]*\}\s*)?([A-Za-z_$][\w$]*)/g))
    names.add(m[1]!);
  // `/** @enum {number} */ const Kind = { ... }`: the constant names a type too.
  for (const m of text.matchAll(
    /@enum\b[^\n]*\n(?:\s*\*[^\n]*\n)*?\s*(?:\*\/\s*)?(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  ))
    names.add(m[1]!);
  const sf = services.parse(file, text, "js");
  for (const stmt of sf.statements.nodes)
    if (ts.isClassDeclaration(stmt) && stmt.name !== undefined) names.add(stmt.name.text);
  return names;
}

export function npmStaticTypeExportPlan(
  services: FrontendServices,
  entryPath: string,
  packages: readonly string[],
): NpmStaticTypeExportPlan {
  const copies = new Map<string, string>();
  const typedefs = new Map<string, string>();
  const parsed = new Map<string, ts.SourceFile | null>();
  const parse = (file: string): ts.SourceFile | null => {
    let sf = parsed.get(file);
    if (sf === undefined) {
      const text = packageSourceText(file);
      sf = text === null ? null : services.parse(file, text, "ts");
      parsed.set(file, sf);
    }
    return sf;
  };
  // Copies every declaration file reachable from `file` through relative
  // specifiers, each specifier respelled to its target's copy.
  const copy = (file: string): void => {
    const copyPath = copyPathOf(file);
    if (copies.has(copyPath)) return;
    const sf = parse(file);
    if (sf === null) return;
    copies.set(copyPath, "");
    const targets = new Map<string, string>();
    for (const specifier of npmStaticDeclarationSpecifiers(sf)) {
      const target = declarationTargetOf(file, specifier);
      if (target !== null) targets.set(specifier, target);
    }
    copies.set(
      copyPath,
      npmStaticDeclarationCopy(sf, (specifier) => {
        const target = targets.get(specifier);
        return target === undefined ? null : specifierFor(copyPath, copyPathOf(target));
      }),
    );
    for (const target of targets.values()) copy(target);
  };
  const exportsOf = new Map<string, NpmStaticDeclarationExports | null>();
  const declarationExports = (file: string): NpmStaticDeclarationExports | null => {
    let ex = exportsOf.get(file);
    if (ex === undefined) {
      const sf = parse(file);
      ex = sf === null ? null : npmStaticDeclarationExports(sf);
      exportsOf.set(file, ex);
    }
    return ex;
  };
  // The exported type-only declarations of `file`, through its re-exports,
  // each with the file that declares it.
  type Found = { decl: NpmStaticTypeDeclaration; file: string };
  const typesOf = (
    file: string,
    seen: Set<string>,
  ): { types: Map<string, Found>; values: Set<string> } => {
    const result = { types: new Map<string, Found>(), values: new Set<string>() };
    if (seen.has(file)) return result;
    seen.add(file);
    const own = declarationExports(file);
    if (own === null) return result;
    for (const t of own.types) result.types.set(t.name, { decl: t, file });
    for (const v of own.values) result.values.add(v);
    for (const n of own.named) {
      const target = n.specifier === null ? null : declarationTargetOf(file, n.specifier);
      if (target === null) continue;
      const inner = typesOf(target, new Set(seen));
      const t = inner.types.get(n.local);
      if (t !== undefined)
        result.types.set(n.exported, { ...t, decl: { ...t.decl, name: n.exported } });
      else if (inner.values.has(n.local)) result.values.add(n.exported);
    }
    for (const specifier of own.stars) {
      const target = declarationTargetOf(file, specifier);
      if (target === null) continue;
      const inner = typesOf(target, new Set(seen));
      for (const [name, t] of inner.types) if (!result.types.has(name)) result.types.set(name, t);
      for (const v of inner.values) result.values.add(v);
    }
    return result;
  };
  // Whether `name`, as `file` sees it, is a data shape: an interface, type
  // alias or enum whose syntax describes no behavior (npm-static-type-
  // exports.ts) and whose referenced types are data shapes too. A name the
  // package's declaration files do not declare is a global (`Array`,
  // `Record`, `Date`); a class, a value or an import from another package
  // is not a data shape.
  //
  // `referencesOf` answers one name: null when it is not a data shape by
  // itself, otherwise the names it refers to.
  type Ref = { file: string; name: string };
  const referencesOf = (file: string, name: string): Ref[] | null => {
    const ex = declarationExports(file);
    if (ex === null) return null;
    const local = ex.locals.get(name);
    if (local !== undefined)
      return local.behavior ? null : local.references.map((r) => ({ file, name: r }));
    if (ex.valueNames.has(name)) return null;
    const from = ex.imports.get(name);
    if (from !== undefined) {
      const target = declarationTargetOf(file, from.specifier);
      return target === null ? null : [{ file: target, name: from.local }];
    }
    const reexport = typesOf(file, new Set()).types.get(name);
    if (reexport !== undefined) return [{ file: reexport.file, name: reexport.decl.declared }];
    return [];
  };
  // A name is a data shape when every name reachable from it is one by
  // itself. `isData` walks everything reachable before it records any name
  // as a data shape, so a type in a reference cycle is not recorded while
  // another type in the cycle is still unchecked.
  const dataMemo = new Map<string, boolean>();
  const isData = (file: string, name: string): boolean => {
    const keyOf = (ref: Ref): string => `${ref.file}\0${ref.name}`;
    // Each reached name, by key, with the key of the name it was reached from.
    const reachedFrom = new Map<string, string | null>([[keyOf({ file, name }), null]]);
    const queue: Ref[] = [{ file, name }];
    for (let i = 0; i < queue.length; i++) {
      const ref = queue[i]!;
      const key = keyOf(ref);
      const memo = dataMemo.get(key);
      if (memo === true) continue;
      const next = memo === false ? null : referencesOf(ref.file, ref.name);
      if (next === null) {
        // Every name on the path to this one reaches a non-data type.
        for (let k: string | null = key; k !== null; k = reachedFrom.get(k) ?? null)
          dataMemo.set(k, false);
        return false;
      }
      for (const target of next) {
        const targetKey = keyOf(target);
        if (reachedFrom.has(targetKey)) continue;
        reachedFrom.set(targetKey, key);
        queue.push(target);
      }
    }
    for (const key of reachedFrom.keys()) dataMemo.set(key, true);
    return true;
  };
  for (const pkg of packages) {
    const declared = resolveBareModule(entryPath, pkg, "types-only");
    if (declared === null || declared.packageName !== pkg || !declared.typesFile.endsWith(".d.ts"))
      continue;
    const runtime = resolveBareModule(entryPath, pkg, "js-only");
    if (runtime === null || !isJsSourceFileName(runtime.typesFile)) continue;
    const runtimeText = packageSourceText(runtime.typesFile);
    if (runtimeText === null) continue;
    const { types, values } = typesOf(declared.typesFile, new Set());
    const declaredByRuntime = runtimeTypeNames(services, runtime.typesFile, runtimeText);
    // Only data shapes: a type with methods describes the package's
    // JavaScript objects, which stay as the JavaScript types them.
    const exported = [...types.values()]
      .filter(
        ({ decl, file }) =>
          !values.has(decl.name) &&
          !declaredByRuntime.has(decl.name) &&
          isData(file, decl.declared),
      )
      .map(({ decl }) => decl);
    if (exported.length === 0) continue;
    copy(declared.typesFile);
    const specifier = specifierFor(runtime.typesFile, copyPathOf(declared.typesFile));
    typedefs.set(
      runtime.typesFile.split("\\").join("/"),
      npmStaticTypedefBlock(exported, specifier),
    );
  }
  return { copies, typedefs };
}
