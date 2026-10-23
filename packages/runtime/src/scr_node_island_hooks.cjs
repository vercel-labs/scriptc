// ── shared modules (scope-B NI-6) ──────────────────────────────────────
// The design's hooks.mjs. scripts/node-island-host.mjs appends this file to
// scr_node_island_host.cjs, so it runs in the bootstrap's scope (CommonJS:
// the bootstrap is Node's main script).
//
// A module the program compiled that island code imports must exist once.
// Synchronous, in-thread loader hooks (module.registerHooks) resolve every
// island import or require() of such a module to a generated ES module
// (served at the module's own file URL) whose bindings hold the live native exports: the
// natives sharedGet/sharedTable/sharedTdz ask the runtime directly. An
// export that can change (an exported let, or a binding still in its
// temporal dead zone when the module linked) is bound: the runtime pushes
// each new native value (sharedPush) before island code can observe it.
//
// Temporal dead zone across a cycle: when an island module loads while a
// shared module's bindings are not yet initialized (the native module is
// still evaluating, as in `core` -> island `ext` -> `core`), the load goes
// through an entry module that imports the island module and declares
// those bindings after the import. The generated module re-exports them
// from the entry, so while the island module evaluates they are in their
// temporal dead zone exactly as in Node (V8 throws its own ReferenceError
// with the importer's binding name), and they are pushed once the native
// declarations ran.
// oxlint-disable-next-line no-unused-vars -- called by scr_node_island_host.cjs, which this file is appended to
function scriptcSharedModules(nativeHost) {
  const { registerHooks } = require("node:module");
  const { fileURLToPath, pathToFileURL } = require("node:url");
  const { dirname, join } = require("node:path");
  const table = JSON.parse(nativeHost.sharedTable());
  const none = { entry: (path, load) => load(null), push() {} };
  if (table.length === 0) return none;
  const byUrl = new Map();
  table.forEach((m, id) => byUrl.set(pathToFileURL(m.path).href, id));
  const TDZ = Symbol("scriptc.tdz");
  const setters = new Map(); // `${mod}:${slot}` -> [(value) => void]
  const entries = new Map(); // entry URL -> { target, late: [[mod, slot]] }
  let entrySeq = 0;
  let current = null; // the entry being loaded

  function addSetter(mod, slot, set) {
    const key = `${mod}:${slot}`;
    const list = setters.get(key);
    if (list === undefined) setters.set(key, [set]);
    else list.push(set);
  }

  const shared = {
    get(mod, slot) {
      return nativeHost.sharedGet(mod, slot, 0, TDZ);
    },
    bind(mod, slot, set) {
      addSetter(mod, slot, set);
      return nativeHost.sharedGet(mod, slot, 1, TDZ);
    },
    late(mod, slot, set) {
      addSetter(mod, slot, set);
      const v = nativeHost.sharedGet(mod, slot, 2, TDZ);
      return v === TDZ ? undefined : v;
    },
  };
  Object.defineProperty(globalThis, Symbol.for("scriptc.shared"), { value: shared });

  const lateName = (mod, slot) => `__scriptc_${mod}_${slot}`;

  function sharedSource(mod) {
    const m = table[mod];
    const lines = ['const __s = globalThis[Symbol.for("scriptc.shared")];'];
    const lateIn = current === null ? null : entries.get(current);
    m.exports.forEach((e, slot) => {
      const name = JSON.stringify(e.name);
      const local = `__e${slot}`;
      const tdz = nativeHost.sharedGet(mod, slot, 0, TDZ) === TDZ;
      if (tdz && lateIn !== null && lateIn.late.some(([a, b]) => a === mod && b === slot)) {
        lines.push(`export { ${lateName(mod, slot)} as ${name} } from ${JSON.stringify(current)};`);
      } else if (tdz) {
        // Reached outside an island load (a lazy require): no entry can hold
        // the dead zone; the binding reads undefined until its declaration
        // runs (NOTES.md shortcut).
        lines.push(`let ${local} = __s.late(${mod}, ${slot}, (v) => { ${local} = v; });`);
        lines.push(`export { ${local} as ${name} };`);
      } else if (e.kind === "let" || e.kind === "var") {
        lines.push(`let ${local} = __s.bind(${mod}, ${slot}, (v) => { ${local} = v; });`);
        lines.push(`export { ${local} as ${name} };`);
      } else {
        lines.push(`const ${local} = __s.get(${mod}, ${slot});`);
        lines.push(`export { ${local} as ${name} };`);
      }
    });
    return lines.join("\n");
  }

  function entrySource(url) {
    const e = entries.get(url);
    const lines = [`import ${JSON.stringify(e.target)};`];
    lines.push('const __s = globalThis[Symbol.for("scriptc.shared")];');
    for (const [mod, slot] of e.late) {
      const n = lateName(mod, slot);
      lines.push(`export let ${n} = __s.late(${mod}, ${slot}, (v) => { ${n} = v; });`);
    }
    return lines.join("\n");
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const asUrl = specifier.startsWith("/") ? pathToFileURL(specifier).href : specifier;
      if (entries.has(asUrl)) return { url: asUrl, shortCircuit: true };
      const resolved = nextResolve(specifier, context);
      // A shared module keeps its own file URL (require() and import key
      // their module records alike only for file URLs); load answers it.
      if (resolved.url.startsWith("file:") && byUrl.has(resolved.url))
        return { url: resolved.url, format: "module", shortCircuit: true };
      return resolved;
    },
    load(url, context, nextLoad) {
      const mod = byUrl.get(url);
      if (mod !== undefined)
        return { format: "module", source: sharedSource(mod), shortCircuit: true };
      if (entries.has(url))
        return { format: "module", source: entrySource(url), shortCircuit: true };
      return nextLoad(url, context);
    },
  });

  return {
    /** The entry to load the island module at `path` through, or null when
     * no shared binding is in its temporal dead zone. Run `load` with it. */
    entry(path, load) {
      const late = JSON.parse(nativeHost.sharedTdz());
      if (late.length === 0) return load(null);
      // A file URL beside the island module (never on disk: the load hook
      // answers it), so require() and import key it alike.
      const url = pathToFileURL(join(dirname(path), `__scriptc_entry_${++entrySeq}.mjs`)).href;
      entries.set(url, { target: pathToFileURL(path).href, late });
      const outer = current;
      current = url;
      try {
        return load(fileURLToPath(url));
      } finally {
        current = outer;
      }
    },
    push(mod, slot, value) {
      for (const set of setters.get(`${mod}:${slot}`) ?? []) set(value);
    },
  };
}
