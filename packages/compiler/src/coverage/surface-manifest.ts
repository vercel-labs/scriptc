import { InternalCompilerError } from "../errors.js";
/* The machine-readable surface manifest: what the static tier compiles at
 * this compiler version, projected MECHANICALLY from the tables that
 * already decide support — the diagnostics registry (diagnostic.ts), the
 * unsupported-syntax dispatch tables and stdlib/builtin lowering tables
 * (lowering/surfaces.ts), and the supported-builtin-module list
 * (frontend/builtin-modules.ts). Nothing here is hand-maintained: adding a table
 * row changes the manifest on the next generation, and the staleness test
 * (tests/harness/surface-manifest.test.ts) fails until the committed file
 * is regenerated (`pnpm manifest`).
 *
 * Schema (schemaVersion 2 — additive changes only; removals or meaning
 * changes bump the number):
 *   {
 *     schemaVersion: 2,
 *     compilerVersion: string,   // the exact published release version —
 *                                // a version pin matches this string
 *     coverage: string[],        // what is and is not projected (the
 *                                // manifest's own scope statement)
 *     entries: [{
 *       id: string,              // STABLE diff key: dotted path, lowercase
 *                                // kebab segments except verbatim member
 *                                // names ("stdlib.string.charCodeAt")
 *       kind: "syntax" | "stdlib" | "node-builtin" | "diagnostic-fence",
 *       name: string,            // human-readable surface name
 *       status: "static" | "unsupported",
 *       code?: "SC____",         // REQUIRED on every non-static entry:
 *                                // the diagnostic code the compiler
 *                                // raises where the refusal applies
 *       note?: string,           // constraints and remediation prose
 *     }]
 *   }
 *
 * Two properties are contract, not incidental shape: (1) compilerVersion
 * is the exact published version string, so external tooling can match a
 * pinned release; (2) every entry whose status is not "static" carries
 * the diagnostic code the compiler actually raises for it — the sampling
 * harness asserts refusals match entry codes. renderSurfaceManifest is
 * byte-deterministic: entries sort by id, keys are emitted in one fixed
 * order, and the output carries no timestamps or absolute paths. */
import { FENCE_CODES, UNSUPPORTED, webAssemblyDiag } from "../diagnostics/diagnostic.js";
import { node24FetchCompatProfile } from "../compat/fetch-profile.js";
import { SUPPORTED_BUILTIN_MODULES, SUPPORTED_NODE_MODULES } from "../frontend/builtin-modules.js";
import {
  ambientSurfaceFns,
  ARRAY_METHODS,
  BUILTIN_MODULE_CONSTS,
  BUILTIN_MODULE_FENCE_HINTS,
  builtinModuleFns,
  COLLECTION_ITERATOR_METHODS,
  COMPOUND_ASSIGN_OPS,
  STDLIB_SURFACE,
  MAP_METHODS,
  SET_COMBINE_METHODS,
  SET_METHODS,
  STATIC_MATH_FNS,
  STATIC_MATH_PROPS,
  STATIC_NUMBER_METHODS,
  STRING_INDEX_METHODS,
  STRING_REPLACE_METHODS,
  STR_METHODS,
  UNSUPPORTED_EXPR,
  UNSUPPORTED_STMT,
} from "../frontend/lowering/surfaces.js";

export type SurfaceEntryKind = "syntax" | "stdlib" | "node-builtin" | "diagnostic-fence";

export type SurfaceEntryStatus = "static" | "unsupported";

export interface SurfaceManifestEntry {
  id: string;
  kind: SurfaceEntryKind;
  name: string;
  status: SurfaceEntryStatus;
  code?: string;
  note?: string;
}

export interface SurfaceManifest {
  schemaVersion: 2;
  compilerVersion: string;
  coverage: string[];
  entries: SurfaceManifestEntry[];
}

export const MANIFEST_SCHEMA_VERSION = 2;

/** The manifest's own scope statement: what the projection covers and —
 * just as load-bearing — what it deliberately leaves out, so absence is
 * never read as a support claim in either direction. */
function coverageNotes(): string[] {
  const fetchTarget = node24FetchCompatProfile().target;
  return [
    "Entries are projected mechanically from the compiler's own decision tables: the diagnostics registry, the unsupported-syntax dispatch tables, the stdlib and node-builtin lowering tables, and the supported-builtin-module list. Nothing is hand-maintained; the manifest regenerates byte-identically from the source tree at this version.",
    "Absence from this manifest means 'not projected', never 'unsupported'. Surfaces lowered through dedicated code paths rather than tables are not yet projected: console, JSON, Promise/async and the timer surface, the net/http/tls/https/dgram/dns/assert/test/stream/readline module member surfaces, template literals, the regex slice, global functions (parseInt, parseFloat, isNaN, isFinite), and the process surface outside its ambient slice.",
    "The ambient-nondeterminism and ambient-authority surfaces the library sidecar's determinism attestation scans ARE projected even where they lower through dedicated code paths — the Date compositions (stdlib.date.*), perf_hooks' performance.now, and the process global's ambient reads and authority calls (node-builtin.process.*) — so a determinism fence can name every surface the attestation demotes on.",
    "stdlib and node-builtin member entries name surface whose LOWERED call forms are constrained (arity, argument shapes); declared call forms outside the lowered set are refused per site, with code SC2020 for standard-library and node-builtin surface.",
    "Entries with status 'unsupported' describe where the named code is raised: forms of the construct outside the supported subset are refused with that code — not that every form of the named feature is refused. Supported forms appear as their own static entries where a table projects them.",
    `The engine-free fetch projection targets Node ${fetchTarget.node} with bundled Undici ${fetchTarget.undici}. Each projected row names the differential evidence that guards it; changing the pinned Node or Undici version is an explicit profile update.`,
    "The fetch profile also contains a runtime-reflected census of the selected fetch, abort, Headers, and readable-stream interfaces plus RequestInit/ResponseInit dictionary reads. Static and unsupported census rows are projected here; its explicitly out-of-scope metadata rows and adjacent-interface exclusions remain in the profile so absence is deliberate rather than ambiguous.",
    "Process-level diagnostic codes are not surface entries: SC0001-SC0004 are preflight gates, SC1110 is a comptime evaluation failure, SC3001/SC3002 are backend/target tier refusals, SC9001/SC9002 are internal errors.",
    "Entry statuses are projected for the desktop targets. The mobile targets (aarch64-apple-ios, aarch64-apple-ios-simulator, aarch64-linux-android) compile library-mode archives only: the library-admissible surface (what SC4005's async_free requirement and the library link set admit) is supported there, the executable lane refuses those triples with SC3002, and no entry outside the library-admissible surface carries a mobile support claim. iOS archives build for iOS 15.0 on darwin hosts; Android archives build against NDK API level 26.",
    "No scheduling metadata is published; entry ids are the stable diff keys across releases.",
  ];
}

/** Stable kebab id segment from prose: quotes dropped, the parenthetical
 * tail dropped, non-alphanumeric runs collapsed to one dash. */
function kebab(text: string): string {
  return text
    .split(" (")[0]!
    .toLowerCase()
    .replace(/['"‘’“”]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Compound-assignment operator ids: spelled names, never punctuation. */
const COMPOUND_OP_NAMES: Record<string, string> = {
  "+": "plus",
  "-": "minus",
  "*": "times",
  "/": "divide",
  "%": "remainder",
  "**": "exponent",
  "&": "bitwise-and",
  "|": "bitwise-or",
  "^": "bitwise-xor",
  "<<": "shift-left",
  ">>": "shift-right",
  ">>>": "shift-right-unsigned",
};

function arityNote(min: number, max: number): string {
  if (min === max) {
    return min === 0
      ? "the lowered call form takes no arguments"
      : `the lowered call form takes exactly ${min} argument${min === 1 ? "" : "s"}`;
  }
  return `the lowered call form takes ${min} to ${max} arguments`;
}

export function generateSurfaceManifest(compilerVersion: string): SurfaceManifest {
  const entries: SurfaceManifestEntry[] = [];
  const add = (e: SurfaceManifestEntry): void => {
    entries.push(e);
  };

  // ── syntax: the unsupported-syntax dispatch tables ────────────────────
  // Keys are numeric SyntaxKind values whose reverse mapping is unreliable
  // (First*/Last* aliases win), so ids derive from the entry's own feature
  // text — the registry feature when the row carries no override.
  for (const table of [UNSUPPORTED_STMT, UNSUPPORTED_EXPR]) {
    for (const entry of Object.values(table)) {
      const name = entry.feature ?? UNSUPPORTED[entry.code]!.feature;
      // Spread arguments have a positive static surface: fixed tuples
      // flatten into fixed signatures, while typed arrays/Sets/class
      // iterables already pack into rest parameters. The fallback table
      // remains the per-site fence for genuinely runtime-arity static
      // calls that reach no supported lane.
      if (name === "spread arguments") continue;
      add({
        id: `syntax.${kebab(name)}`,
        kind: "syntax",
        name,
        status: "unsupported",
        code: entry.code,
      });
    }
  }

  // ── syntax: compound assignment (the one positive syntax table) ───────
  for (const op of Object.values(COMPOUND_ASSIGN_OPS)) {
    add({
      id: `syntax.compound-assignment.${COMPOUND_OP_NAMES[op]!}`,
      kind: "syntax",
      name: `compound assignment operator '${op}='`,
      status: "static",
      note: `compiles over the operand types the '${op}' operator supports`,
    });
  }
  for (const [id, name, note] of [
    [
      "bigint-literals",
      "bigint literals",
      "arbitrary-precision values in decimal, binary, octal, and hexadecimal spelling",
    ],
    [
      "async-generators",
      "typed async generator functions and methods",
      "lazy bodies with queued next/return/throw requests, await, direct yield, and Node-compatible completion promises",
    ],
    [
      "for-await-async-generators",
      "for await over typed async generators",
      "awaits each IteratorResult and closes the generator on early break",
    ],
    [
      "for-await-readable-streams",
      "for await over Node Readable and Web ReadableStream values",
      "closes on every abrupt completion, with destroyOnReturn and preventCancel literal options",
    ],
    [
      "for-await-class-async-iterators",
      "for await over statically represented class async iterators",
      "drives zero-parameter next methods returning Promise<{ value, done? }> and awaits an optional zero-parameter return method on abrupt completion",
    ],
    [
      "using-declarations",
      "block- and function-scoped using declarations",
      "LIFO disposal on normal and abrupt scope exit through [Symbol.dispose], of class instances, object literals and Disposable-typed values; a failing disposal raises a SuppressedError with error and suppressed",
    ],
    [
      "await-using-declarations",
      "block- and function-scoped await using declarations",
      "LIFO asynchronous disposal through [Symbol.asyncDispose], with synchronous fallback, of class instances, object literals and AsyncDisposable-typed values",
    ],
    [
      "for-using-of",
      "for (using ... of ...) over arrays",
      "each array element is disposed at the end of its iteration, including break and continue paths",
    ],
    [
      "finally-abrupt-completions",
      "abrupt completions through finally",
      "return, throw, break, continue, and labeled jumps run crossed finally blocks; a finally completion replaces the pending one",
    ],
    [
      "spread-arguments",
      "spread arguments",
      "non-empty fixed tuples flatten into fixed signatures with evaluate-once ordering; arrays, Sets, and statically represented class iterables spread into typed rest parameters",
    ],
  ] as [string, string, string][]) {
    add({ id: `syntax.${id}`, kind: "syntax", name, status: "static", note });
  }

  // ── stdlib: string / array / map / set method surfaces ────────────────
  for (const [name, entry] of Object.entries(STR_METHODS)) {
    add({
      id: `stdlib.string.${name}`,
      kind: "stdlib",
      name: `string.prototype.${name}`,
      status: "static",
      note: arityNote(entry.minArgs, entry.maxArgs),
    });
  }
  for (const name of STRING_INDEX_METHODS) {
    add({
      id: `stdlib.string.${name}`,
      kind: "stdlib",
      name: `string.prototype.${name}`,
      status: "static",
      note: arityNote(0, 1),
    });
  }
  for (const name of STRING_REPLACE_METHODS) {
    add({
      id: `stdlib.string.${name}`,
      kind: "stdlib",
      name: `string.prototype.${name}`,
      status: "static",
      note: "string patterns with primitive replacements or typed callbacks; regex forms have separate lowering",
    });
  }
  for (const name of [...ARRAY_METHODS]) {
    add({
      id: `stdlib.array.${name}`,
      kind: "stdlib",
      name: `Array.prototype.${name}`,
      status: "static",
    });
  }
  for (const name of [...MAP_METHODS]) {
    add({
      id: `stdlib.map.${name}`,
      kind: "stdlib",
      name: `Map.prototype.${name}`,
      status: "static",
      ...(COLLECTION_ITERATOR_METHODS.has(name)
        ? {
            note: "live native iterators support next(), for...of, drains, and the iterator helper methods",
          }
        : {}),
    });
  }
  for (const name of [...SET_METHODS]) {
    add({
      id: `stdlib.set.${name}`,
      kind: "stdlib",
      name: `Set.prototype.${name}`,
      status: "static",
      ...(COLLECTION_ITERATOR_METHODS.has(name)
        ? {
            note: "live native iterators support next(), for...of, drains, and the iterator helper methods",
          }
        : {}),
    });
  }
  for (const name of [...SET_COMBINE_METHODS]) {
    add({
      id: `stdlib.set.${name}`,
      kind: "stdlib",
      name: `Set.prototype.${name}`,
      status: "static",
      note: "compiles over Set receivers with Set arguments and Map arguments keyed by the element type (other ReadonlySetLike argument forms are refused per site)",
    });
  }

  const mathNames = new Set([
    ...Object.keys(STATIC_MATH_FNS),
    ...Object.keys(STDLIB_SURFACE.math.fns),
  ]);
  for (const name of mathNames) {
    const stat = STATIC_MATH_FNS[name];
    const declared = STDLIB_SURFACE.math.fns[name];
    if (stat !== undefined) {
      add({
        id: `stdlib.math.${name}`,
        kind: "stdlib",
        name: `Math.${name}`,
        status: "static",

        // Untabled shapes may have
        // their own special-cased lowerings (Math.min/max over one array
        // spread), so no claim is made about them.
        note:
          name === "hypot"
            ? "compiles statically at any arity, including number[] spreads"
            : `compiles statically at arity ${stat.arity}` +
              (declared !== undefined
                ? "; other declared call shapes are refused with SC2012"
                : ""),
      });
    } else {
      add({
        id: `stdlib.math.${name}`,
        kind: "stdlib",
        name: `Math.${name}`,
        status: "unsupported",
        code: "SC2012",
      });
    }
  }
  for (const name of Object.keys(STDLIB_SURFACE.math.props)) {
    add({
      id: `stdlib.math.${name}`,
      kind: "stdlib",
      name: `Math.${name}`,
      status: "unsupported",
      code: "SC2012",
    });
  }
  for (const name of Object.keys(STATIC_MATH_PROPS)) {
    add({
      id: `stdlib.math.${name}`,
      kind: "stdlib",
      name: `Math.${name}`,
      status: "static",
      note: "the constant read compiles to a numeric literal; no runtime Math read is performed",
    });
  }
  const numberNames = new Set([
    ...Object.keys(STATIC_NUMBER_METHODS),
    ...Object.keys(STDLIB_SURFACE.number),
  ]);
  for (const name of numberNames) {
    const stat = Object.hasOwn(STATIC_NUMBER_METHODS, name)
      ? STATIC_NUMBER_METHODS[name]
      : undefined;
    if (stat !== undefined) {
      add({
        id: `stdlib.number.${name}`,
        kind: "stdlib",
        name: `number.prototype.${name}`,
        status: "static",
        note: arityNote(stat.minArgs, stat.maxArgs),
      });
    } else {
      add({
        id: `stdlib.number.${name}`,
        kind: "stdlib",
        name: `number.prototype.${name}`,
        status: "unsupported",
        code: "SC2012",
      });
    }
  }
  for (const name of Object.keys(STDLIB_SURFACE.string)) {
    if (STRING_INDEX_METHODS.has(name) || STRING_REPLACE_METHODS.has(name)) continue;
    add({
      id: `stdlib.string.${name}`,
      kind: "stdlib",
      name: `string.prototype.${name}`,
      status: "unsupported",
      code: "SC2012",
    });
  }
  // STDLIB_SURFACE.globals (parseFloat, isFinite) is deliberately NOT
  // projected: those globals also lower statically over exactly-typed
  // arguments through untabled call paths; the table alone cannot classify them.

  // ── node-builtin: modules, members, constants, named fences ───────────
  const moduleId = (mod: string): string => `node-builtin.${mod.split("/").join(".")}`;
  for (const mod of SUPPORTED_BUILTIN_MODULES) {
    const prefixOnly = !SUPPORTED_NODE_MODULES.includes(mod);
    add({
      id: moduleId(mod),
      kind: "node-builtin",
      name: prefixOnly ? `node:${mod}` : mod,
      status: "static",
      note: prefixOnly
        ? "recognized module (node:-prefixed specifier only, matching Node)"
        : "recognized module (bare and node:-prefixed specifiers)",
    });
  }
  for (const [mod, members] of Object.entries(builtinModuleFns())) {
    for (const member of Object.keys(members!)) {
      add({
        id: `${moduleId(mod)}.${member}`,
        kind: "node-builtin",
        name: `${mod}.${member}`,
        status: "static",
      });
    }
  }
  for (const [mod, members] of Object.entries(BUILTIN_MODULE_CONSTS)) {
    for (const member of Object.keys(members!)) {
      add({
        id: `${moduleId(mod)}.${member}`,
        kind: "node-builtin",
        name: `${mod}.${member}`,
        status: "static",
        note: "constant value read",
      });
    }
  }
  for (const [mod, members] of Object.entries(BUILTIN_MODULE_FENCE_HINTS)) {
    for (const [member, hint] of Object.entries(members!)) {
      add({
        id: `${moduleId(mod)}.${member}`,
        kind: "node-builtin",
        name: `${mod}.${member}`,
        status: "unsupported",
        code: "SC2020",
        ...(hint !== undefined ? { note: hint } : {}),
      });
    }
  }

  // ── the WebAssembly global (builtins/webassembly.ts, wasm/translate.ts):
  // the core API lowers over modules translated at build time; the rest
  // refuses at each use (webAssemblyDiag) ─
  {
    const refusal = webAssemblyDiag("WebAssembly", { file: "", start: 0, end: 0 });
    add({
      id: "stdlib.webassembly",
      kind: "stdlib",
      name: "globalThis.WebAssembly",
      status: "static",
      note: `compile, instantiate, validate, the Module, Instance, Memory, Table and Global constructors, Module.imports, exports and customSections, instanceof, the error classes, exports, imports and Module transfer to workers, over the modules translated at build time; the rest refuses with ${refusal.code} (${refusal.hint ?? ""})`,
    });
  }

  // ── fetch/Web platform: one explicit, versioned compatibility profile ─
  const fetchProfile = node24FetchCompatProfile();
  const fetchTarget = `Node ${fetchProfile.target.node} / Undici ${fetchProfile.target.undici}`;
  for (const operation of fetchProfile.operations) {
    const evidence = operation.evidence.map((item) =>
      item.generated !== undefined ? `generated:${item.generated}` : `fixture:${item.fixture!}`,
    );
    add({
      id: operation.id,
      kind: "stdlib",
      name: operation.name,
      status: "static",
      note:
        `${fetchTarget}; facets: ${operation.facets.join(", ")};` +
        (operation.scope !== undefined ? ` supported scope: ${operation.scope};` : "") +
        " " +
        `differential evidence: ${evidence.join(", ")}`,
    });
  }
  for (const options of [fetchProfile.requestInit, fetchProfile.responseInit]) {
    for (const option of options) {
      const evidence = option.evidence.map((item) =>
        item.generated !== undefined ? `generated:${item.generated}` : `fixture:${item.fixture!}`,
      );
      add({
        id: option.id,
        kind: "stdlib",
        name: option.name,
        status: "static",
        note:
          `${fetchTarget}; conversion: ${option.conversion}; ` +
          `differential evidence: ${evidence.join(", ")}`,
      });
    }
  }
  for (const row of fetchProfile.inventory.entries) {
    if (row.status !== "unsupported") continue;
    if (row.code === undefined || row.reason === undefined) {
      throw new InternalCompilerError(`non-static fetch inventory row '${row.id}' is incomplete`);
    }
    const name =
      row.placement === "constructor"
        ? `${row.owner} constructor`
        : row.placement === "dictionary"
          ? `${row.owner}.${row.member}`
          : row.owner === "globalThis"
            ? row.member
            : `${row.owner}.${row.member}`;
    add({
      id: row.id,
      kind: "stdlib",
      name,
      status: row.status,
      code: row.code,
      note: `${fetchTarget}; ${row.reason}`,
    });
  }

  // ── ambient dedicated-path surfaces: the attestation's ground ─────────
  // Date/perf_hooks/process rows from the one ambient table — each entry
  // is fenceable by construction (its row carries the reach-witnessing
  // libCall spellings the fence detector uses).
  for (const row of ambientSurfaceFns()) {
    add({
      id: row.id,
      kind: row.kind,
      name: row.name,
      status: "static",
      ...(row.note !== undefined ? { note: row.note } : {}),
    });
  }

  // ── diagnostic-fence: the enumerable refusal codes ─────────────────────
  for (const [code, entry] of Object.entries(UNSUPPORTED)) {
    add({
      id: `diagnostic.${code.toLowerCase()}`,
      kind: "diagnostic-fence",
      name: entry.feature,
      status: "unsupported",
      code,
      ...(entry.hint !== undefined ? { note: entry.hint } : {}),
    });
  }
  for (const [code, entry] of Object.entries(FENCE_CODES)) {
    if (code in UNSUPPORTED)
      throw new InternalCompilerError(
        `diagnostic code ${code} is in both UNSUPPORTED and FENCE_CODES`,
      );
    add({
      id: `diagnostic.${code.toLowerCase()}`,
      kind: "diagnostic-fence",
      name: entry.name,
      status: entry.status,
      code,
    });
  }

  // ── invariants, then the stable order ──────────────────────────────────
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) throw new InternalCompilerError(`duplicate manifest id: ${e.id}`);
    seen.add(e.id);
    if (e.status !== "static" && e.code === undefined) {
      throw new InternalCompilerError(
        `manifest entry ${e.id} has status ${e.status} but no diagnostic code`,
      );
    }
    if (e.code !== undefined && !/^SC\d{4}$/.test(e.code)) {
      throw new InternalCompilerError(`manifest entry ${e.id} has a malformed code: ${e.code}`);
    }
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    compilerVersion,
    coverage: coverageNotes(),
    entries,
  };
}

/** The manifest's one serialization: key order fixed by construction,
 * two-space indent, trailing newline — byte-identical for the same tree
 * and version on every platform. */
export function renderSurfaceManifest(manifest: SurfaceManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}
