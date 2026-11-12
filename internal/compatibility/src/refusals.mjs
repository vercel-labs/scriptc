/* The refusal table: every place the compiler refuses a program that names
 * a Node API, in one machine-readable artifact.
 *
 * The ledger's `refused` rows are API-level refusals, and a row carries the
 * access path a program has to reach it. The builtin-module list supplies
 * the load-layer refusals: modules the compiler fences by name, with the
 * reason its diagnostic prints. Rows the sources cannot place keep
 * `binding: "unknown"` instead of a guessed access path.
 *
 * The same output is committed under internal/compatibility/generated/ and
 * published as @scriptc/experimental/refusals.json, so a Node development
 * loop reads the compiler's answers without reimplementing its tables.
 */

// builtin-modules.ts imports nothing, so Node's type stripping loads it
// without a compiler build; this generator runs on the same Node 24 pin as
// the ledger.
import {
  NODE_BUILTIN_MODULES_V24,
  SUPPORTED_BUILTIN_MODULES,
  unsupportedModuleFeatureOf,
} from "../../../packages/compiler/src/frontend/builtin-modules.ts";

export const REFUSALS_SCHEMA_VERSION = 1;

/** The documented module names a chapter's symbols may be written under
 * beyond the chapter's own modules: a subpath export such as
 * `streamConsumers.blob` is documented under webstreams but imported from
 * `node:stream/consumers`. */
const SYMBOL_ALIASES = [
  ["fsPromises.", "fs/promises."],
  ["dnsPromises.", "dns/promises."],
  ["timersPromises.", "timers/promises."],
  ["streamPromises.", "stream/promises."],
  ["streamConsumers.", "stream/consumers."],
];

/** The binding's access kind for a documented row's API kind. */
function accessOf(kind) {
  switch (kind) {
    case "method":
    case "function":
      return "call";
    case "property":
      return "get";
    case "class":
      return "construct";
    case "event":
      return "listen";
    case "global":
      return "get";
    default:
      return "unknown";
  }
}

/** The binding {module, path, access} of a documented row, or "unknown"
 * when no module spelling of the chapter accounts for its symbol. */
function bindingOfRow(row, chapterModules) {
  const symbols = new Set([row.apiSymbol]);
  for (const symbol of [row.apiSymbol]) {
    for (const [from, to] of SYMBOL_ALIASES) {
      if (symbol.startsWith(from)) symbols.add(to + symbol.slice(from.length));
    }
  }
  const modules = [
    ...new Set([...(chapterModules[row.chapter] ?? []), ...SUPPORTED_BUILTIN_MODULES]),
  ].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  for (const symbol of symbols) {
    for (const module of modules) {
      const spellings = new Set([module, module.replaceAll("/", ".")]);
      for (const spelling of spellings) {
        if (symbol === spelling)
          return { module: `node:${module}`, path: [], access: accessOf(row.kind) };
        if (symbol.startsWith(`${spelling}.`)) {
          return {
            module: `node:${module}`,
            path: symbol.slice(spelling.length + 1).split("."),
            access: accessOf(row.kind),
          };
        }
      }
    }
  }
  return "unknown";
}

/** The surface-manifest entry a ledger row's refusal names, or null. */
function manifestIdOf(row) {
  const evidence = row.static?.evidence ?? "";
  const prefix = "surface-manifest:unsupported:";
  return evidence.startsWith(prefix) ? evidence.slice(prefix.length) : null;
}

/** Every builtin module Node serves that scriptc neither lowers nor serves
 * as an npm alias, canonical bare names in the pinned Node's order. */
export function unsupportedBuiltinModules() {
  const supported = new Set(SUPPORTED_BUILTIN_MODULES);
  return [...new Set(NODE_BUILTIN_MODULES_V24.map((name) => name.replace(/^node:/, "")))].filter(
    (name) => !supported.has(name),
  );
}

/** Build the refusal table from a compatibility ledger. `chapterModules`
 * is the pin's chapter-to-module map; `compilerVersion` is the release
 * version stamped into every generated artifact. */
export function buildRefusals(snapshot, { chapterModules, compilerVersion }) {
  const refusals = [];
  for (const row of snapshot.rows) {
    if (row.static?.status !== "refused") continue;
    const manifestId = manifestIdOf(row);
    if (manifestId === null) continue;
    refusals.push({
      row: row.id,
      layer: "static",
      chapter: row.chapter,
      apiSymbol: row.apiSymbol,
      kind: row.kind,
      label: row.label,
      manifestId,
      binding: bindingOfRow(row, chapterModules),
    });
  }
  refusals.sort((a, b) =>
    a.chapter < b.chapter
      ? -1
      : a.chapter > b.chapter
        ? 1
        : a.apiSymbol < b.apiSymbol
          ? -1
          : a.apiSymbol > b.apiSymbol
            ? 1
            : a.row < b.row
              ? -1
              : a.row > b.row
                ? 1
                : 0,
  );
  for (const module of unsupportedBuiltinModules()) {
    const spec = `node:${module}`;
    refusals.push({
      binding: { module: spec, access: "import" },
      code: "SC1010",
      message: `${unsupportedModuleFeatureOf(spec)} is not supported yet`,
      layer: "load",
    });
  }
  return {
    schemaVersion: REFUSALS_SCHEMA_VERSION,
    nodeVersion: snapshot.nodeVersion,
    compilerVersion,
    refusals,
  };
}

export function renderRefusals(refusals) {
  return `${JSON.stringify(refusals, null, 2)}\n`;
}
