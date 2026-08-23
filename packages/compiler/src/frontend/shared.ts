/* World-neutral program-lifecycle constants and helpers — strings,
 * numbers, and path predicates only, no AST, checker, or enum objects.
 * Split out when two frontend lanes (typescript@5.9.3 and the TS7
 * adapter) had to share them without exchanging world-typed objects;
 * program.ts re-exports all of it, so lowering-side import sites kept
 * their spelling across the phase-4 flip that retired the 5.9.3 lane. */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** tsgo uses slash-normalized file names on Windows (for SourceFile names
 * and virtual-FS callbacks), while Node's path APIs use backslashes there.
 * POSIX backslashes stay literal: they are valid filename characters. */
export function tsgoPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

/** Path of the shipped ambient declarations — the always-shipped CORE
 * (comptime/__island_eval, setTimeout). Part of EVERY program scriptc
 * builds, the project-world preflight program included. */
export function ambientDtsPath(): string {
  return tsgoPath(require.resolve("@scriptc/compiler/scriptc.d.ts"));
}

/** Path of the shipped divergence/precision OVERRIDES (JSON.parse():
 * unknown, pop(): T, the Promise executor shape, ...). Part of the LOWERING
 * program only — preflight's project-world second chance builds without it,
 * so a project that typechecks under its own tsc never fails preflight over
 * an override-manufactured error (checkPreflight). */
export function overridesDtsPath(): string {
  return tsgoPath(require.resolve("@scriptc/compiler/scriptc-overrides.d.ts"));
}

/** Path of the shipped FALLBACK declarations (console, process, node:fs) —
 * part of the program only when the target project has no @types/node.
 * With @types/node, the project's real Node types stand in and this file
 * stands down (its declaration forms would collide). */
export function fallbackDtsPath(): string {
  return tsgoPath(require.resolve("@scriptc/compiler/scriptc-node-fallback.d.ts"));
}

/** True for files belonging to the adopted Node type surface: the
 * @types/node package itself and undici-types (its dependency — the
 * web-platform globals: fetch/Response/AbortSignal/ReadableStream/...).
 * The provenance half of the lowering tables' recognition when the
 * fallback declarations stand down, and of the SC2020-family fence for
 * everything else those packages declare. */
export function isNodeTypesPath(file: string): boolean {
  const pkg = npmPackageNameOf(file);
  return pkg === "@types/node" || pkg === "undici-types";
}

/** The node builtin modules with scriptc lowerings, by CANONICAL (bare)
 * name — every module answers to both specifier forms ("fs" and "node:fs"
 * are the same module, like in Node). When the fallback declarations ship,
 * this is exactly the set of `declare module` names in that file; when
 * @types/node stands in (which declares ALL node builtins) the supported
 * surface must not widen, so preflight allowlists this same fixed set. */
export const SUPPORTED_BUILTIN_MODULES = ["fs", "path", "path/posix", "path/win32", "os", "url", "fs/promises", "crypto", "zlib", "child_process", "net", "http", "tls", "https", "dgram", "dns", "util", "util/types", "string_decoder", "querystring", "readline", "http2", "assert", "assert/strict", "worker_threads", "buffer", "cluster", "tty", "async_hooks", "events", "stream", "stream/promises", "stream/consumers", "test", "timers", "timers/promises", "diagnostics_channel", "perf_hooks", "module"] as const;

/** Builtins Node itself serves ONLY under the node: prefix —
 * require("test") is MODULE_NOT_FOUND in Node, so the bare name stays a
 * user-package specifier and never canonicalizes to the builtin. Bare
 * "module" is NOT in this set: Node serves the builtin for both spellings
 * (a builtin always wins over a same-named npm package for the bare
 * specifier — the npm package named "module" is unreachable in Node too),
 * so both spellings key the same lowering tables here. */
const PREFIX_ONLY_BUILTIN_MODULES: ReadonlySet<string> = new Set(["test"]);

/** The builtin modules whose DEFAULT import binding lowers: node:assert's
 * module object IS a callable function (`import assert from "node:assert";
 * assert(x)`), and node:events' module object IS the EventEmitter class
 * (`module.exports = EventEmitter` — `import EventEmitter from
 * "node:events"; new EventEmitter()`), so those default bindings lower —
 * for every other builtin the default-import fence stands. */
export function builtinDefaultImportModule(spec: string): string | null {
  const canon = canonicalBuiltinModule(spec);
  // node:test's module object IS the test function (`import test from
  // "node:test"; test(...)`), like assert's callable module object.
  return canon === "assert" || canon === "assert/strict" || canon === "events" || canon === "test"
    ? canon
    : null;
}

/** Canonical (bare) name of a supported builtin-module specifier — "fs"
 * for both "fs" and "node:fs" — or null for everything else. The lowering
 * tables and the preflight allowlist share this one normalization. */
export function canonicalBuiltinModule(spec: string): string | null {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  if (bare === spec && PREFIX_ONLY_BUILTIN_MODULES.has(bare)) return null;
  return (SUPPORTED_BUILTIN_MODULES as readonly string[]).includes(bare) ? bare : null;
}

/** Both specifier spellings of every supported builtin (prefix-only ones
 * keep just the node: form) — the ambient-module allowlist preflight uses. */
export const SUPPORTED_NODE_MODULES: readonly string[] = SUPPORTED_BUILTIN_MODULES.flatMap((m) =>
  PREFIX_ONLY_BUILTIN_MODULES.has(m) ? [`node:${m}`] : [m, `node:${m}`],
);

/* ── out-of-scope builtins ───────────────────────────────────────────────
 * Builtin modules a compiled binary is not going to serve — not "yet",
 * but by construction — each with the reason its SC1010 fence prints.
 * Keyed by CANONICAL (bare) name; the node: prefix strips before lookup,
 * so 'node:sqlite' keys as 'sqlite'. Exact-match only: an npm package
 * whose name collides with none of these keys keeps the generic wording.
 * Everything absent from this table stays the plain "not supported yet"
 * story — genuinely pending surface (console's Console class, stream/web)
 * must not read as permanently refused. */

/** Node's own HTTP/TLS/stream implementation internals, requireable by
 * legacy convention (underscore-prefixed lib/ modules). They expose
 * Node-internal objects — parsers, wrap handles, the Agent's socket
 * pools — that only exist inside Node's own stack. */
const NODE_INTERNAL_REASON =
  "a Node-internal module: it exposes Node's own implementation objects, which the scriptc runtime does not replicate";

const V8_REASON =
  "it observes V8 engine internals — heap statistics and snapshots, GC and CPU profiles, serialize/deserialize — and a compiled binary embeds no V8 engine to observe";

const OUT_OF_SCOPE_BUILTIN_REASONS: Record<string, string | undefined> = {
  v8: V8_REASON,
  inspector: "it drives the V8 inspector protocol — debugger, profiler, heap access — and a compiled binary embeds no V8 engine to inspect",
  "inspector/promises": "it drives the V8 inspector protocol — debugger, profiler, heap access — and a compiled binary embeds no V8 engine to inspect",
  sqlite: "it wraps the SQLite library bundled into the node executable, and scriptc binaries bundle no SQLite engine",
  domain: "deprecated in Node and slated for removal; its implicit error interception hooks every async callback at engine level, which is not modeled",
  _http_agent: NODE_INTERNAL_REASON,
  _http_client: NODE_INTERNAL_REASON,
  _http_common: NODE_INTERNAL_REASON,
  _http_incoming: NODE_INTERNAL_REASON,
  _http_outgoing: NODE_INTERNAL_REASON,
  _http_server: NODE_INTERNAL_REASON,
  _stream_duplex: NODE_INTERNAL_REASON,
  _stream_passthrough: NODE_INTERNAL_REASON,
  _stream_readable: NODE_INTERNAL_REASON,
  _stream_transform: NODE_INTERNAL_REASON,
  _stream_wrap: NODE_INTERNAL_REASON,
  _stream_writable: NODE_INTERNAL_REASON,
  _tls_common: NODE_INTERNAL_REASON,
  _tls_wrap: NODE_INTERNAL_REASON,
};

/** The SC1010 feature string for an unsupported module specifier: the
 * plain "the 'x' module" for pending surface, with the out-of-scope
 * reason appended for the modules above. Every "the '<spec>' module"
 * fence site words through this one helper. */
export function unsupportedModuleFeatureOf(spec: string): string {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  const reason = Object.hasOwn(OUT_OF_SCOPE_BUILTIN_REASONS, bare) ? OUT_OF_SCOPE_BUILTIN_REASONS[bare] : undefined;
  return reason === undefined ? `the '${spec}' module` : `the '${spec}' module (${reason})`;
}

/* ── workspace-linked packages ───────────────────────────────────────────
 * A bare specifier can resolve through node_modules to a SYMLINK whose real
 * location lies outside every node_modules directory — the workspace link
 * every monorepo tool installs for internal packages (pnpm, npm, yarn, and
 * bun workspaces all do). Node resolves and runs such a package exactly
 * like any installed one, and so does scriptc — but the resolved files'
 * REALPATHS carry no node_modules segment, so every path-keyed package
 * attribution (which package declared this symbol, which package does this
 * diagnostic belong to, is this file inside the --npm-static opt-in) needs
 * this registry: real package directory → package name, filled by the
 * resolver as workspace links are discovered and reset per load. */

const workspacePackageDirs = new Map<string, string>();

export function registerWorkspacePackage(name: string, realDir: string): void {
  workspacePackageDirs.set(realDir.split("\\").join("/"), name);
}

export function clearWorkspacePackages(): void {
  workspacePackageDirs.clear();
}

/** True when `name` is a registered workspace package — the NAME-keyed
 * twin of workspacePackageOfPath, for call sites that hold a bare import
 * specifier instead of a file path (a workspace member installed by COPY
 * has no out-of-node_modules files to match, but its name registered all
 * the same). */
export function isWorkspacePackageName(name: string): boolean {
  for (const n of workspacePackageDirs.values()) {
    if (n === name) return true;
  }
  return false;
}

/** The registered workspace package a path lies inside, or null. */
export function workspacePackageOfPath(path: string): string | null {
  const norm = path.split("\\").join("/");
  for (const [dir, name] of workspacePackageDirs) {
    if (norm === dir || (norm.startsWith(dir) && norm[dir.length] === "/")) return name;
  }
  return null;
}

/** Node's relative-specifier family: './x', '../x', and the bare '.' /
 * '..' directory forms (path resolution treats them identically —
 * real CLIs import `from '..'` for a parent directory's index).
 * Anything else is a package, builtin, or package.json-mediated
 * specifier. ('...' and friends are legal PACKAGE names — only the exact
 * dot forms are relative.) */
export function isRelativeSpecifier(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

/** Package-name prefix of a bare specifier: "@scope/pkg/sub" becomes
 * "@scope/pkg", while "pkg/sub" becomes "pkg". */
export function packageNameOfSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Package name from a path under node_modules — the LAST node_modules
 * segment (nested installs blame the innermost package), scoped-aware:
 * ".../node_modules/@scope/pkg/dist/x.d.ts" → "@scope/pkg". Paths with no
 * node_modules segment answer their registered workspace package (the
 * realpath'd home of a symlinked workspace install), else null. */
export function npmPackageNameOf(file: string): string | null {
  const parts = file.split("/");
  const i = parts.lastIndexOf("node_modules");
  if (i < 0 || i + 1 >= parts.length) return workspacePackageOfPath(file);
  const first = parts[i + 1]!;
  if (first.startsWith("@")) {
    const second = parts[i + 2];
    return second ? `${first}/${second}` : first;
  }
  return first;
}

/* The compiler-options split (documented in SEMANTICS.md; the enum-valued
 * FORCED knobs are spelled per world — each lane owns its enum objects):
 * ADOPTED knobs change which programs typecheck; FORCED knobs change
 * semantics scriptc depends on; strictNullChecks is a FLOOR. */
export const ADOPTED_OPTIONS = [
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "alwaysStrict",
  "useUnknownInCatchVariables",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noPropertyAccessFromIndexSignature",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noUnusedLocals",
  "noUnusedParameters",
  "allowUnusedLabels",
  "allowUnreachableCode",
  "skipLibCheck",
  // Import-form interop knobs: they only change which import FORMS
  // typecheck (default imports of CJS-shaped types) — the import fence
  // rejects unsupported forms with SC-diagnostics either way, and a
  // SC1012 "not supported yet" beats a raw TS1259 at the same site.
  "esModuleInterop",
  "allowSyntheticDefaultImports",
] as const;

/* The JAVASCRIPT strictness stance (the JS-input design made real):
 * JavaScript sources carry no annotations, so tsc's strictness families
 * that exist to demand annotations — or to reject dynamically-typed
 * idioms that are ordinary, working JS — cannot be satisfied by the
 * program's author at all. The design already says where inference gaps
 * land: exactly where `any` lands in TS (island under --dynamic, honest
 * fences without). So for JS FILES ONLY, these tsc families are not
 * preflight gates; the values involved stay `any`/loose and every use
 * meets the lowerer's per-site fences instead. TypeScript sources keep
 * the full strict gate — nothing here weakens the default for annotated
 * programs. */
export const JS_RELAXED_TSC_CODES: ReadonlySet<number> = new Set([
  // implicit any (params, variables, elements, this, returns, rest,
  // construct signatures, index reads over shapes with no index
  // signature — typeof globalThis)
  2683, 7005, 7006, 7008, 7009, 7010, 7015, 7017, 7019, 7022, 7023, 7024, 7031, 7034, 7053,
  // strict-null narrowing demands (possibly null/undefined receivers)
  2531, 2532, 2533, 18047, 18048, 18049,
  // assignability/arity/callability of dynamic call shapes (valid JS,
  // checked at runtime by Node; the lowerer re-checks every lowered form
  // per site) and member/existence probes over dynamic shapes (expando
  // properties, capability probes — the lowerer fences unknown members
  // per site with the SC2020 family)
  2322, 2339, 2345, 2349, 2351, 2367, 2554, 2555, 2556, 2769,
  2740, // 2322's elaborated "missing the following properties" form
  2305, 2551, 2724, 2731,
  // excess object-literal properties against a JSDoc-inferred contextual
  // type (and the did-you-mean variant): ordinary, working JS — the extra
  // key rides the object at runtime exactly as written (the formatter idiom's
  // expand-patterns passes an ignoreUnknown member its own JSDoc type
  // never declared)
  2353, 2561,
  // JSDoc TYPE-SPACE claims that fail to check: a value name in a type
  // position (2749/2702), generic constraints and index types spelled in
  // typedefs (2344/2536/2538), an async @returns that is not Promise
  // (1064), and 2366's no-ending-return against a JSDoc-declared return
  // type. The claims are documentation — Node never reads them; the
  // values keep their runtime behavior and every use meets the per-site
  // fences (the pattern's source carries dozens of each).
  2749, 2702, 2344, 2536, 2538, 1064, 2366,
  // strict-null demands on dynamic shapes, continued: iterating/invoking
  // possibly-undefined values (runtime re-checks at the site)
  2488, 2721, 2722,
  // an UNUSED @ts-expect-error: the directive annotated an error visible
  // under the project's OWN tsconfig world — scriptc's world deliberately
  // differs (adopted options, hidden declaration twins), and an unused
  // suppression changes nothing at runtime
  2578,
  // a lib-floor demand (es2024+ members under the es2023 lib): the member
  // types as the error-any and its use fences per site with the honest
  // no-lowering story instead of gating the whole program
  2550,
  // `export *` ambiguity (2308): Node DEFINES this case — ambiguous names
  // are excluded from the star surface — where tsc asks for an explicit
  // re-export; and 2305's did-you-mean sibling 2614 joins 2305
  2308, 2614,
  // 2740's sibling elaboration ("Property X is missing in type Y")
  2741,
  // unresolvable modules: Node throws WHEN the require executes — the
  // binding types as any and reached uses fence (never a silent pass)
  2307, 2792,
  // useUnknownInCatchVariables' annotation demand ("'e' is of type
  // 'unknown'", "Object is of type 'unknown'"): a JS catch clause CANNOT
  // annotate its variable, so the demand is unsatisfiable in source —
  // exactly the implicit-any story above. The values stay 'unknown' and
  // every use meets the lowerer's per-site unknown fences (member reads
  // ride the checked-dynamic tree; unsupported operations fence loudly).
  18046, 2571,
]);

/* Arithmetic on an `any` operand (TS2362/2363/2365 fire when the other
 * side is bigint-ish): plain JS — relaxed only when 'any' participates. */
export const JS_ANY_OPERATOR_CODES: ReadonlySet<number> = new Set([2362, 2363, 2365]);

/** True for JavaScript source file NAMES (.js/.mjs/.cjs/.jsx) — the files
 * whose types come entirely from inference (checkJs + JSDoc) and whose JS
 * relaxation stance applies. */
export function isJsSourceFileName(fileName: string): boolean {
  return /\.(js|mjs|cjs|jsx)$/.test(fileName);
}
