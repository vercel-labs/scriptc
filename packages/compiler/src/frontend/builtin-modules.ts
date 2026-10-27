/** The node builtin modules with scriptc lowerings, by canonical bare name. */
export const SUPPORTED_BUILTIN_MODULES = [
  "fs",
  "path",
  "path/posix",
  "path/win32",
  "os",
  "url",
  "fs/promises",
  "crypto",
  "zlib",
  "child_process",
  "net",
  "http",
  "tls",
  "https",
  "dgram",
  "dns",
  "util",
  "util/types",
  "string_decoder",
  "querystring",
  "readline",
  "readline/promises",
  "http2",
  "assert",
  "assert/strict",
  "worker_threads",
  "buffer",
  "cluster",
  "tty",
  "async_hooks",
  "events",
  "stream",
  "stream/promises",
  "stream/consumers",
  "test",
  "timers",
  "timers/promises",
  "diagnostics_channel",
  "perf_hooks",
  "module",
  "console",
  "process",
  "v8",
  "stream/web",
  "dns/promises",
  "punycode",
  "constants",
] as const;

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
  if ((SUPPORTED_BUILTIN_MODULES as readonly string[]).includes(bare)) return bare;
  return bare === spec ? npmBuiltinAliasOf(spec) : null;
}

/** npm packages served as a builtin module instead of compiling their
 * JavaScript (maintainer decision): graceful-fs monkeypatches the fs
 * module object and queues retries on EMFILE/ENFILE, which statically
 * lowered fs calls cannot honor, and it behaves as fs everywhere else. Its
 * import and require resolve to node:fs; gracefulify is a no-op statement.
 * The one documented difference: no retry queueing under file-descriptor
 * exhaustion. */
const NPM_BUILTIN_ALIASES: Record<string, string | undefined> = { "graceful-fs": "fs" };

/** The builtin module an npm package specifier is served as, or null. */
export function npmBuiltinAliasOf(spec: string): string | null {
  return Object.hasOwn(NPM_BUILTIN_ALIASES, spec) ? (NPM_BUILTIN_ALIASES[spec] ?? null) : null;
}

/** Both specifier spellings of every supported builtin (prefix-only ones
 * keep just the node: form) — the ambient-module allowlist preflight uses
 * — plus the npm packages served as builtins. */
export const SUPPORTED_NODE_MODULES: readonly string[] = [
  ...SUPPORTED_BUILTIN_MODULES.flatMap((m) =>
    PREFIX_ONLY_BUILTIN_MODULES.has(m) ? [`node:${m}`] : [m, `node:${m}`],
  ),
  ...Object.keys(NPM_BUILTIN_ALIASES),
];

/* ── out-of-scope builtins ───────────────────────────────────────────────
 * Builtin modules a compiled binary is not going to serve — not "yet",
 * but by construction — each with the reason its SC1010 fence prints.
 * Keyed by CANONICAL (bare) name; the node: prefix strips before lookup,
 * so 'node:sqlite' keys as 'sqlite'. Exact-match only: an npm package
 * whose name collides with none of these keys keeps the generic wording.
 * Everything absent from this table stays the plain "not supported yet"
 * story — genuinely pending surface (console's Console class) must not
 * read as permanently refused. */

/** Node's own HTTP/TLS/stream implementation internals, requireable by
 * legacy convention (underscore-prefixed lib/ modules). They expose
 * Node-internal objects — parsers, wrap handles, the Agent's socket
 * pools — that only exist inside Node's own stack. */
const NODE_INTERNAL_REASON =
  "a Node-internal module: it exposes Node's own implementation objects, which the scriptc runtime does not replicate";

/** node:v8 is importable (packages require it at top level and touch it
 * only on optional paths), and getHeapStatistics answers allocator-derived
 * figures; every other member observes the engine itself. Member fences
 * carry this reason instead of a module-level refusal. */
export const V8_MEMBER_REASON =
  "by design: this member observes V8 engine internals — heap snapshots and spaces, GC and CPU profiles, flags, serialize/deserialize — and a compiled binary embeds no V8 engine to observe";

const OUT_OF_SCOPE_BUILTIN_REASONS: Record<string, string | undefined> = {
  vm: "it compiles and runs JavaScript source at runtime, and a compiled binary embeds no JavaScript engine to run it",
  inspector:
    "it drives the V8 inspector protocol — debugger, profiler, heap access — and a compiled binary embeds no V8 engine to inspect",
  "inspector/promises":
    "it drives the V8 inspector protocol — debugger, profiler, heap access — and a compiled binary embeds no V8 engine to inspect",
  sqlite:
    "it wraps the SQLite library bundled into the node executable, and scriptc binaries bundle no SQLite engine",
  domain:
    "deprecated in Node and slated for removal; its implicit error interception hooks every async callback at engine level, which is not modeled",
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
  const reason = Object.hasOwn(OUT_OF_SCOPE_BUILTIN_REASONS, bare)
    ? OUT_OF_SCOPE_BUILTIN_REASONS[bare]
    : undefined;
  return reason === undefined ? `the '${spec}' module` : `the '${spec}' module (${reason})`;
}

/** The ESNext temporal global's name. Node 24 does not define it: programs
 * that name it type-check against TS 7's lib slice (program.ts adds it only
 * for them) and lower to Node's answers. Spelled in two pieces so the
 * compiler's own sources never trip program.ts's scan when scriptc
 * compiles itself. */
export const TEMPORAL_GLOBAL = "Tempo" + "ral";
