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
// export that can change (an exported let, var or function declaration,
// whose binding JavaScript allows reassigning, or a binding still in its
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
  const { realpathSync } = require("node:fs");
  // Node resolves an import to the module's real path, so a module of a
  // tree reached through a symbolic link (a cache directory under macOS's
  // /var, which is /private/var) is keyed by its real path as well.
  const byUrl = new Map();
  table.forEach((m, id) => {
    byUrl.set(pathToFileURL(m.path).href, id);
    try {
      byUrl.set(pathToFileURL(realpathSync(m.path)).href, id);
    } catch {
      // A module that is not on disk keeps only its own path.
    }
  });
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
      } else if (e.kind === "let" || e.kind === "var" || e.kind === "function") {
        // A function declaration's binding is reassignable, like `var`:
        // the island must see the current function, not the first one.
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

// ── the load plan ──────────────────────────────────────────────────────
// What Node's resolver answers for the program's module tree was computed
// when the program was built and ships in the tree as `.scriptc/load-plan`
// (compiler node-islands/load-plan.ts, which states the rules and the file's
// layout). These hooks answer a request from the plan and leave every other
// one to Node, so a start no longer builds URLs, calls stat and walks
// realpath for each file of a package. Nothing V8 sees changes: each file
// is still compiled under its own name and linked by Node's loaders.
//
// An answer is exactly what the next step of the chain would return:
// - resolve, from `require`: `{ url, format: undefined }`, the URL of the
//   file's real path (wrapResolveFilename and convertCJSFilenameToURL in
//   Node's CommonJS loader);
// - resolve, from `import`, of an ES module: `{ url, format: "module" }`
//   (defaultResolve);
// - load of an ES module this hook resolved: `{ format: "module", source }`
//   with the bytes of the file (defaultLoadSync). CommonJS sources stay
//   Node's read: its default already reads by file name.
// Node's default steps read state a package may replace (`Module`'s
// resolution functions, the extension table, `fs.realpathSync`,
// `fs.readFileSync`, `fs.openSync`); the values are captured here, before
// island code runs, and a request is answered only while they are in place.
// An asynchronous loader (`module.register`) is the same: its hooks answer
// before Node's default steps, so the plan would hide them from every
// request it answers. Once one is registered, Node resolves everything.
//
// The plan does not look at the disk. When a file it names is gone from the
// tree, the read fails with ENOENT on the file's path in the tree (this
// hook's read of an ES module, Node's own read of a CommonJS one); no other
// file loads in its place. A tree without its plan file is resolved by Node
// alone.
//
// SCRIPTC_NODE_ISLANDS_PLAN=off in the program's environment leaves every
// request to Node; =verify asks Node as well and fails the load when the
// two answers differ. SCRIPTC_NODE_ISLANDS_TRACE=plan prints each answer.
// oxlint-disable-next-line no-unused-vars -- called by scr_node_island_host.cjs, which this file is appended to
function scriptcLoadPlan(root, given) {
  const mode = process.env.SCRIPTC_NODE_ISLANDS_PLAN;
  if (mode === "off") return;
  const fs = require("node:fs");
  const Module = require("node:module");
  const { sep } = require("node:path");
  const { pathToFileURL } = require("node:url");
  const planFile = `${root}${sep}.scriptc${sep}load-plan`;
  if (!fs.existsSync(planFile)) return;
  const verify = mode === "verify";
  const traced = (process.env.SCRIPTC_NODE_ISLANDS_TRACE ?? "").includes("plan");
  const trace = (line) => fs.writeSync(2, `[node-islands] plan ${line}\n`);

  // The module's URL is the root's URL and the file's path in the tree:
  // plan paths hold no character pathToFileURL escapes or rewrites.
  const rootUrl = pathToFileURL(root + sep).href;
  const realPrefix = root + sep;
  const givenPrefix = given.endsWith(sep) ? given : given + sep;
  const PLAIN = /^[A-Za-z0-9._\-/@+~=,]+$/;
  // An empty, `.` or `..` segment: not a path the tree names.
  const UNNORMALIZED = /(?:^|\/)\.{0,2}(?:\/|$)/;

  const original = {
    resolveFilename: Module._resolveFilename,
    findPath: Module._findPath,
    lookupPaths: Module._resolveLookupPaths,
    stat: Module._stat,
    readPackage: Module._readPackage,
    realpathSync: fs.realpathSync,
    readFileSync: fs.readFileSync,
    openSync: fs.openSync,
  };
  function requireResolutionIntact() {
    const extensions = Object.keys(Module._extensions);
    return (
      Module._resolveFilename === original.resolveFilename &&
      Module._findPath === original.findPath &&
      Module._resolveLookupPaths === original.lookupPaths &&
      Module._stat === original.stat &&
      Module._readPackage === original.readPackage &&
      fs.realpathSync === original.realpathSync &&
      extensions.length === 3 &&
      extensions[0] === ".js" &&
      extensions[1] === ".json" &&
      extensions[2] === ".node"
    );
  }

  // A package can register an asynchronous loader with `module.register()`.
  // That loader's hooks run in a separate thread and see a request before
  // Node's default steps; the synchronous hooks here answer first, so a
  // short-circuited answer would skip the loader's resolution and source
  // transformations. Node loads internal/modules/esm/hooks when a loader
  // registers (also one registered before this bootstrap, such as
  // `--experimental-loader`), and the entry stays in the list, so the plan
  // stops answering the moment it appears.
  const ASYNC_LOADER = "NativeModule internal/modules/esm/hooks";
  let enumerated = 0;
  let asyncLoader = false;
  function asyncLoaderRegistered() {
    if (asyncLoader) return true;
    const list = process.moduleLoadList;
    for (; enumerated < list.length; enumerated++) {
      if (list[enumerated] === ASYNC_LOADER) {
        asyncLoader = true;
        return true;
      }
    }
    return false;
  }

  const REQUIRE = 1;
  const IMPORT = 2;
  // Node passes each loader's own conditions array: remembered by identity.
  let requireConditions = null;
  let importConditions = null;
  function kindOf(conditions) {
    if (conditions === requireConditions) return REQUIRE;
    if (conditions === importConditions) return IMPORT;
    if (!Array.isArray(conditions)) return 0;
    const require = conditions.includes("require");
    const imports = conditions.includes("import");
    if (require === imports) return 0;
    if (require) requireConditions = conditions;
    else importConditions = conditions;
    return require ? REQUIRE : IMPORT;
  }

  let image; // the plan's bytes; null when it cannot be used
  let bodies = 0; // where the documents start
  const ranges = new Map(); // group directory -> [offset, length]
  const groups = new Map(); // group directory -> its document
  const parents = new Map(); // parent URL -> Map(specifier -> [group, require id, import id]) | null
  const entries = new Map(); // absolute path -> URL | null
  const sources = new Map(); // URL of an ES module this hook resolved -> its path

  function open() {
    image = null;
    try {
      const bytes = original.readFileSync(planFile);
      const end = bytes.indexOf(10);
      const header = JSON.parse(bytes.toString("utf8", 0, end));
      if (header.v !== 1) return;
      for (const [directory, offset, length] of header.groups)
        ranges.set(directory, [offset, length]);
      bodies = end + 1;
      image = bytes;
    } catch {
      // Not a plan this bootstrap reads: Node resolves everything.
    }
  }

  function group(directory) {
    let found = groups.get(directory);
    if (found === undefined) {
      const [offset, length] = ranges.get(directory);
      const ids = new Map();
      // A document that does not read as one answers nothing.
      let document = { files: [], extern: [], requests: [] };
      try {
        document = JSON.parse(image.toString("utf8", bodies + offset, bodies + offset + length));
        document.files.forEach((file, id) => ids.set(file, id));
      } catch {
        ids.clear();
      }
      found = { prefix: directory === "" ? "" : `${directory}/`, ids, ...document };
      groups.set(directory, found);
    }
    return found;
  }

  /** The group that holds the tree file at `path` and the file's id in
   * it, or null: the nearest directory above the file that has a group. */
  function fileOf(path) {
    for (let at = path.lastIndexOf("/"); ; at = path.lastIndexOf("/", at - 1)) {
      const directory = at < 0 ? "" : path.slice(0, at);
      if (ranges.has(directory)) {
        const found = group(directory);
        const id = found.ids.get(path.slice(found.prefix.length));
        return id === undefined ? null : [found, id];
      }
      if (at < 0) return null;
    }
  }

  function targetPath(found, id) {
    const n = found.files.length;
    return id < n ? found.prefix + found.files[id] : found.extern[id - n];
  }

  function requestsOf(parentURL) {
    let requests = parents.get(parentURL);
    if (requests !== undefined) return requests;
    requests = null;
    if (parentURL.startsWith(rootUrl)) {
      const path = parentURL.slice(rootUrl.length);
      const file = PLAIN.test(path) ? fileOf(path) : null;
      if (file !== null) {
        const [found, id] = file;
        const triples = found.requests[id];
        requests = new Map();
        for (let k = 0; k < triples.length; k += 3)
          requests.set(triples[k], [found, triples[k + 1], triples[k + 2]]);
      }
    }
    parents.set(parentURL, requests);
    return requests;
  }

  /** The URL of the module file a load names by its absolute path (the
   * program's own loads: no parent), or null. */
  function entryOf(specifier) {
    let url = entries.get(specifier);
    if (url !== undefined) return url;
    url = null;
    const prefix = specifier.startsWith(givenPrefix)
      ? givenPrefix
      : specifier.startsWith(realPrefix)
        ? realPrefix
        : null;
    if (prefix !== null) {
      const path = specifier.slice(prefix.length);
      if (PLAIN.test(path) && !UNNORMALIZED.test(path) && fileOf(path) !== null)
        url = rootUrl + path;
    }
    entries.set(specifier, url);
    return url;
  }

  function planned(specifier, context) {
    if (asyncLoaderRegistered()) return undefined;
    if (image === undefined) open();
    if (image === null) return undefined;
    const attributes = context.importAttributes;
    if (attributes !== undefined && attributes !== null && Object.keys(attributes).length > 0)
      return undefined;
    const kind = kindOf(context.conditions);
    if (kind === 0) return undefined;
    const parentURL = context.parentURL;
    if (parentURL === undefined) {
      if (kind !== REQUIRE || typeof specifier !== "string") return undefined;
      const url = entryOf(specifier);
      if (url === null || !requireResolutionIntact()) return undefined;
      return { url, format: undefined, shortCircuit: true };
    }
    if (typeof parentURL !== "string") return undefined;
    const requests = requestsOf(parentURL);
    if (requests === null) return undefined;
    const request = requests.get(specifier);
    if (request === undefined) return undefined;
    const id = request[kind];
    if (id < 0) return undefined;
    const path = targetPath(request[0], id);
    const url = rootUrl + path;
    if (kind === REQUIRE) {
      if (!requireResolutionIntact()) return undefined;
      return { url, format: undefined, shortCircuit: true };
    }
    if (fs.realpathSync !== original.realpathSync) return undefined;
    sources.set(url, realPrefix + path);
    return { url, format: "module", shortCircuit: true };
  }

  function mismatch(what, mine, nodes) {
    const message = `scriptc: the load plan and Node disagree on ${what}: the plan answers ${mine}, Node answers ${nodes}`;
    fs.writeSync(2, `${message}\n`);
    const error = new Error(message);
    error.code = "ERR_SCRIPTC_LOAD_PLAN";
    return error;
  }

  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const answer = planned(specifier, context);
      if (answer === undefined) return nextResolve(specifier, context);
      if (traced) trace(`resolve ${specifier} from ${context.parentURL ?? "the program"}`);
      if (verify) {
        const nodes = nextResolve(specifier, context);
        if (nodes.url !== answer.url || (nodes.format ?? undefined) !== answer.format)
          throw mismatch(
            `'${specifier}' from ${context.parentURL ?? "the program"}`,
            `${answer.url} (${answer.format})`,
            `${nodes.url} (${nodes.format})`,
          );
      }
      return answer;
    },
    load(url, context, nextLoad) {
      const path = sources.get(url);
      if (
        path === undefined ||
        asyncLoaderRegistered() ||
        context.format !== "module" ||
        kindOf(context.conditions) !== IMPORT ||
        fs.readFileSync !== original.readFileSync ||
        fs.openSync !== original.openSync
      )
        return nextLoad(url, context);
      const attributes = context.importAttributes;
      if (attributes !== undefined && attributes !== null && Object.keys(attributes).length > 0)
        return nextLoad(url, context);
      const source = fs.readFileSync(path);
      if (traced) trace(`load ${url}`);
      if (verify) {
        const nodes = nextLoad(url, context);
        const theirs = typeof nodes.source === "string" ? Buffer.from(nodes.source) : nodes.source;
        if (nodes.format !== "module" || theirs === null || Buffer.compare(source, theirs) !== 0)
          throw mismatch(`the source of ${url}`, "module source", `${nodes.format} source`);
      }
      return { format: "module", source, shortCircuit: true };
    },
  });
}
