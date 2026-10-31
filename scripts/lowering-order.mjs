#!/usr/bin/env node
/* Finds lowering state whose result depends on the order reachable bodies
 * lower in.
 *
 * Each program is lowered to IR in discovery order and with every seed of
 * SCRIPTC_LOWER_SHUFFLE_SEED (lowerer.ts), and the IR is compared function
 * by function. Output assembly does not depend on the order, so every
 * difference is state one body's lowering leaves for another. The
 * discovery-order run also audits the lowerer's Map and Set fields: a key
 * that two bodies touch, at least one of them writing it, makes the field
 * order-sensitive for both bodies. A function whose IR differs between
 * orders is attributed to the order-sensitive fields of the body that
 * produced it.
 *
 *   node scripts/lowering-order.mjs [--stride 7] [--offset 0] [--limit N]
 *     [--seeds 1,2,3] [--jobs 8] [--entry <file.ts>]... [--out <dir>]
 *     [--fail-on names|content]
 *
 * --stride and --offset sample the top-level corpus programs by number, or by
 * a hash of the name of a program without one.
 *
 * Needs a built compiler (pnpm build). Writes <out>/results.json and prints
 * a ranking of fields by the programs whose IR they change. With --fail-on,
 * it exits with status 1 when some program's IR differs between orders:
 * in any way (names), or beyond names and ids (content). */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "packages/compiler/dist");

if (process.argv[2] === "--child") {
  const [, , , entry, irPath, seed, auditPath, snapshotPath] = process.argv;
  if (seed !== "-") process.env["SCRIPTC_LOWER_SHUFFLE_SEED"] = seed;
  const module = (path) => import(pathToFileURL(join(dist, path)).href);
  const audit =
    auditPath === "-"
      ? null
      : installAudit(
          await module("frontend/lowering/lowerer.js"),
          await module("frontend/lowering/class-dynamic-dispatch.js"),
          await module("frontend/lowering/deferred-module-initializers.js"),
        );
  const snapshots = installSnapshot(await module("frontend/lowering/lowerer.js"));
  const { compile } = await import(pathToFileURL(join(dist, "index.js")).href);
  const outDir = join(tmpdir(), `scriptc-lowering-order-${process.pid}`);
  const result = await compile(entry, {
    outDir,
    outPath: irPath,
    backend: "llvm",
    outputKind: "ir",
  });
  if (audit !== null) writeFileSync(auditPath, JSON.stringify(audit.report()));
  writeFileSync(snapshotPath, JSON.stringify(snapshots.at(-1) ?? {}));
  process.exit(result.ok ? 0 : 3);
}

/** Records the contents of the lowerer's Map and Set fields once reachable
 * emit finishes, under keys that do not depend on the process: syntax
 * nodes by file and span, symbols by name and declaration, IR values by id
 * or name. Values are digested to a bounded depth. */
function installSnapshot({ Lowerer }) {
  const snapshots = [];
  const nodeKey = (node) => {
    try {
      return `node:${node.getSourceFile().fileName}:${node.kind}:${node.pos}:${node.end}`;
    } catch {
      return `node:?:${node.kind}:${node.pos}:${node.end}`;
    }
  };
  const isNode = (value) =>
    typeof value.kind === "number" &&
    typeof value.pos === "number" &&
    typeof value.end === "number" &&
    typeof value.getSourceFile === "function";
  const isSymbol = (value) =>
    typeof value.escapedName === "string" && Array.isArray(value.declarationHandles);
  const symbolKey = (symbol) => {
    let declaration = "";
    try {
      const first = symbol.declarations[0];
      if (first !== undefined) declaration = nodeKey(first);
    } catch {}
    return `symbol:${symbol.escapedName}:${declaration}`;
  };
  const key = (value) => {
    if (value === null || (typeof value !== "object" && typeof value !== "function"))
      return `${typeof value}:${String(value)}`;
    if (isNode(value)) return nodeKey(value);
    if (isSymbol(value)) return symbolKey(value);
    for (const field of ["name", "id", "localId"])
      if (typeof value[field] === "string" || typeof value[field] === "number")
        return `${value.constructor?.name}:${field}:${value[field]}`;
    if (value.def && typeof value.def.name === "string")
      return `${value.constructor?.name}:def:${value.def.name}`;
    return null;
  };
  const digest = (value, depth) => {
    if (value === null || value === undefined || typeof value !== "object")
      return typeof value === "function" ? "fn" : (JSON.stringify(value) ?? "undefined");
    const stable = key(value);
    if (depth === 0) return stable ?? `<${value.constructor?.name}>`;
    if (isNode(value) || isSymbol(value)) return stable;
    if (Array.isArray(value)) return `[${value.map((item) => digest(item, depth - 1)).join(",")}]`;
    if (value instanceof Map)
      return `Map{${[...value]
        .map(([k, v]) => `${key(k) ?? "?"}=>${digest(v, depth - 1)}`)
        .sort()
        .join(",")}}`;
    if (value instanceof Set)
      return `Set{${[...value]
        .map((item) => key(item) ?? digest(item, depth - 1))
        .sort()
        .join(",")}}`;
    const fields = Object.keys(value).sort();
    return `${value.constructor?.name ?? "Object"}{${fields.map((field) => `${field}:${digest(value[field], depth - 1)}`).join(",")}}`;
  };
  const emitReachable = Lowerer.prototype.emitReachable;
  Lowerer.prototype.emitReachable = function (...args) {
    const result = emitReachable.apply(this, args);
    const snapshot = {};
    for (const [field, value] of Object.entries(this)) {
      if (!(value instanceof Map) && !(value instanceof Set)) continue;
      const entries = {};
      const unkeyed = [];
      for (const item of value instanceof Map ? value : [...value].map((v) => [v, true])) {
        const [k, v] = item;
        const stable = key(k);
        const text = digest(v, 3);
        if (stable === null) unkeyed.push(text);
        else entries[stable] = text;
      }
      snapshot[field] = { entries, unkeyed: unkeyed.sort() };
    }
    snapshots.push(snapshot);
    return result;
  };
  return snapshots;
}

/** Wraps the lowering methods that produce bodies and the lowerer's Map and
 * Set fields; records which bodies touch which keys. */
function installAudit({ Lowerer }, { ClassDynamicDispatch }, { DeferredModuleInitializers }) {
  const proto = Lowerer.prototype;
  const tokens = [];
  const stack = [];
  const fields = new Map();
  const objectIds = new Map();
  const keyId = (key) => {
    if (key === null || (typeof key !== "object" && typeof key !== "function"))
      return `${typeof key}:${String(key)}`;
    let id = objectIds.get(key);
    if (id === undefined) objectIds.set(key, (id = objectIds.size));
    return `object:${id}`;
  };
  const current = () => (stack.length === 0 ? null : stack[stack.length - 1]);
  const touch = (field, key, write) => {
    const token = current();
    if (token === null) return;
    let keys = fields.get(field);
    if (keys === undefined) fields.set(field, (keys = new Map()));
    const id = key === ITERATE ? "*" : keyId(key);
    let entry = keys.get(id);
    if (entry === undefined) keys.set(id, (entry = { readers: new Set(), writers: new Set() }));
    (write ? entry.writers : entry.readers).add(token.id);
  };
  const ITERATE = Symbol("iterate");
  const instrument = (field, value) => {
    const read = (key) => touch(field, key, false);
    const write = (key) => {
      touch(field, key, true);
      // A write changes what every iteration of the field observes.
      touch(field, ITERATE, true);
    };
    const iterate = () => touch(field, ITERATE, false);
    const base = value instanceof Map ? Map.prototype : Set.prototype;
    for (const name of ["get", "has"]) {
      if (!(name in base)) continue;
      const original = base[name];
      value[name] = function (key) {
        read(key);
        return original.call(this, key);
      };
    }
    for (const name of ["set", "add", "delete"]) {
      if (!(name in base)) continue;
      const original = base[name];
      value[name] = function (key, ...rest) {
        write(key);
        return original.call(this, key, ...rest);
      };
    }
    for (const name of ["forEach", "keys", "values", "entries", Symbol.iterator]) {
      const original = base[name];
      value[name] = function (...args) {
        iterate();
        return original.apply(this, args);
      };
    }
    const size = Object.getOwnPropertyDescriptor(base, "size").get;
    Object.defineProperty(value, "size", {
      get() {
        iterate();
        return size.call(this);
      },
    });
  };
  const emitReachable = proto.emitReachable;
  proto.emitReachable = function (...args) {
    for (const [field, value] of Object.entries(this))
      if (value instanceof Map || value instanceof Set) instrument(field, value);
    return emitReachable.apply(this, args);
  };
  const produced = (result, into) => {
    if (result === null || result === undefined) return;
    if (Array.isArray(result)) for (const fn of result) produced(fn, into);
    else if (typeof result === "object" && typeof result.name === "string") into.add(result.name);
  };
  // Passes over the lowered bodies after the worklist: the functions they
  // create belong to the pass.
  const passes = new Map();
  const wrapPass = (owner, label, method) => {
    const original = owner.prototype[method];
    owner.prototype[method] = function (lowerer, ...rest) {
      const implicit = lowerer.implicitFns?.length ?? 0;
      const lifted = lowerer.liftedFns?.length ?? 0;
      try {
        return original.call(this, lowerer, ...rest);
      } finally {
        let names = passes.get(label);
        if (names === undefined) passes.set(label, (names = new Set()));
        for (const fn of (lowerer.implicitFns ?? []).slice(implicit)) names.add(fn.name);
        for (const fn of (lowerer.liftedFns ?? []).slice(lifted)) names.add(fn.name);
      }
    };
  };
  wrapPass(ClassDynamicDispatch, "ClassDynamicDispatch.process", "process");
  wrapPass(ClassDynamicDispatch, "ClassDynamicDispatch.finalize", "finalize");
  wrapPass(DeferredModuleInitializers, "DeferredModuleInitializers.process", "process");
  for (const name of [
    "lowerFunction",
    "lowerClassCtor",
    "lowerClassMethodMember",
    "lowerClassMembers",
    "lowerFileInit",
    "lowerGenericInstance",
    "throwingSetterFn",
  ]) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = function (...args) {
      const token = { id: tokens.length, names: new Set() };
      tokens.push(token);
      const implicit = this.implicitFns?.length ?? 0;
      const lifted = this.liftedFns?.length ?? 0;
      stack.push(token);
      try {
        const result = original.apply(this, args);
        produced(result, token.names);
        return result;
      } finally {
        stack.pop();
        for (const fn of (this.implicitFns ?? []).slice(implicit)) token.names.add(fn.name);
        for (const fn of (this.liftedFns ?? []).slice(lifted)) token.names.add(fn.name);
      }
    };
  }
  return {
    report() {
      const out = {};
      for (const [field, keys] of fields) {
        const involved = new Set();
        let sensitive = 0;
        for (const { readers, writers } of keys.values()) {
          const all = new Set([...readers, ...writers]);
          if (writers.size === 0 || all.size < 2) continue;
          sensitive++;
          for (const id of all) for (const fn of tokens[id].names) involved.add(fn);
        }
        if (sensitive > 0) out[field] = { sensitiveKeys: sensitive, functions: [...involved] };
      }
      for (const [label, names] of passes)
        if (names.size > 0) out[`pass ${label}`] = { sensitiveKeys: 0, functions: [...names] };
      return out;
    },
  };
}

const { values } = parseArgs({
  options: {
    stride: { type: "string", default: "7" },
    offset: { type: "string", default: "0" },
    limit: { type: "string", default: "100000" },
    seeds: { type: "string", default: "1,2,3" },
    jobs: { type: "string", default: String(Math.max(1, Math.floor(cpus().length / 2))) },
    entry: { type: "string", multiple: true, default: [] },
    out: { type: "string", default: join(tmpdir(), "scriptc-lowering-order") },
    "no-audit": { type: "boolean", default: false },
    "fail-on": { type: "string" },
  },
});
if (values["fail-on"] !== undefined && !["names", "content"].includes(values["fail-on"]))
  throw new Error(`--fail-on takes names or content, not ${values["fail-on"]}`);
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const seeds = values.seeds.split(",").filter(Boolean);
/** A top-level corpus program's sampling key: its number, or, for a program
 * named without one, a stable hash of its name (FNV-1a). */
const programKey = (name) =>
  /^\d+-/.test(name)
    ? Number.parseInt(name, 10)
    : [...name].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
/** Numbered programs by number, then the named ones by name. */
const programOrder = (a, b) =>
  /^\d+-/.test(a) !== /^\d+-/.test(b)
    ? /^\d+-/.test(a)
      ? -1
      : 1
    : programKey(a) - programKey(b) || (a < b ? -1 : a > b ? 1 : 0);
const corpus = join(root, "tests/corpus");
const programs = [
  ...readdirSync(corpus)
    .filter((name) => /^[\w-]+\.ts$/.test(name) && statSync(join(corpus, name)).isFile())
    .filter((name) => programKey(name) % Number(values.stride) === Number(values.offset))
    .sort(programOrder)
    .slice(0, Number(values.limit))
    .map((name) => join(corpus, name)),
  ...values.entry.map((entry) => resolve(entry)),
];

const child = (entry, irPath, seed, auditPath, snapshotPath) =>
  new Promise((done) => {
    const proc = spawn(
      process.execPath,
      [
        "--max-old-space-size=8192",
        fileURLToPath(import.meta.url),
        "--child",
        entry,
        irPath,
        seed,
        auditPath,
        snapshotPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, SCRIPTC_NO_CACHE: "1" } },
    );
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("close", (code) => done({ ok: code === 0, stderr: stderr.slice(-2000) }));
  });

const loadIr = (path) => JSON.parse(readFileSync(path, "utf8"));
const firstDiff = (x, y, path = "") => {
  if (JSON.stringify(x) === JSON.stringify(y)) return null;
  if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return path;
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const found = firstDiff(x[key], y[key], `${path}/${key}`);
    if (found !== null) return found;
  }
  return path;
};
const differingFunctions = (a, b) => {
  const left = new Map(a.functions.map((fn) => [fn.name, fn]));
  const right = new Map(b.functions.map((fn) => [fn.name, fn]));
  const names = new Set();
  const paths = {};
  for (const [name, fn] of left) {
    const other = right.get(name);
    if (other === undefined) names.add(name);
    else if (JSON.stringify(other) !== JSON.stringify(fn)) {
      names.add(name);
      paths[name] = firstDiff(fn, other).replace(/\/\d+/g, "/#");
    }
  }
  for (const name of right.keys()) if (!left.has(name)) names.add(name);
  const topLevel = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (key !== "functions" && JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      topLevel.push(key);
  if (a.functions.map((fn) => fn.name).join("\n") !== b.functions.map((fn) => fn.name).join("\n"))
    topLevel.push("function order");
  return { functions: [...names], topLevel, paths };
};

/** Keys whose strings name functions, locals, globals, shapes, unions,
 * classes and labels. Lowering numbers these in creation order; every other
 * string (literal values, field names, library functions) is compared as
 * is. A `name` names a function, record or union when it is one of the
 * module's numbered definitions or starts with `%`. */
const ID_KEYS = new Set([
  "base",
  "callee",
  "captures",
  "catchLocalId",
  "className",
  "fnName",
  "fromId",
  "globalId",
  "id",
  "int32Locals",
  "int32Params",
  "label",
  "labels",
  "localId",
  "retag",
  "shapeId",
  "targets",
  "unionId",
]);

/** The module with every numbered function, record and union renamed by a
 * hash of its own definition (ids with their digits stripped), other
 * numbered ids by first use within their function or table entry, source
 * locations dropped, and tables sorted. Orders whose canonical modules
 * match differ only in names and ids numbered in creation order. */
const canonicalModule = (mod) => {
  const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);
  const m = JSON.parse(JSON.stringify(mod, (k, v) => (k === "loc" ? undefined : v)));
  const definitions = new Set([
    ...(m.functions ?? []).map((fn) => fn.name),
    ...["records", "unions"].flatMap((key) => (m[key] ?? []).map((item) => item.id)),
  ]);
  const isId = (key, value) =>
    ID_KEYS.has(key) || (key === "name" && (definitions.has(value) || value.startsWith("%")));
  /** `v` with the strings under id keys passed through `id`. */
  const mapIds = (v, id, key) => {
    if (typeof v === "string") return isId(key, v) ? id(v) : v;
    if (Array.isArray(v)) return v.map((x) => mapIds(x, id, key));
    if (v && typeof v === "object")
      return Object.fromEntries(Object.keys(v).map((k) => [k, mapIds(v[k], id, k)]));
    return v;
  };
  const strip = (v) => JSON.stringify(mapIds(v, (id) => id.replace(/\d+/g, "#")));
  const rename = new Map();
  for (const fn of m.functions ?? []) {
    if (!/\d/.test(fn.name)) continue;
    const { name, ...rest } = fn;
    rename.set(name, `${name.replace(/\d+/g, "#")}~${hash(strip(rest))}`);
  }
  for (const key of ["records", "unions"])
    for (const item of m[key] ?? []) {
      const { id, ...rest } = item;
      if (typeof id === "string" && /\d/.test(id))
        rename.set(id, `${id.replace(/\d+/g, "#")}~${hash(strip(rest))}`);
    }
  const canonical = (item) => {
    const scope = new Map();
    return mapIds(item, (value) => {
      const renamed = rename.get(value);
      if (renamed !== undefined) return renamed;
      if (!/\d/.test(value)) return value;
      let id = scope.get(value);
      if (id === undefined) scope.set(value, (id = scope.size));
      return `${value.replace(/\d+/g, "#")}@${id}`;
    });
  };
  const out = {};
  for (const key of Object.keys(m))
    out[key] = Array.isArray(m[key])
      ? m[key].map((item) => JSON.stringify(canonical(item))).sort()
      : JSON.stringify(canonical(m[key]));
  return out;
};
/** Canonical entries present in one order only, by table. */
const contentDifferences = (a, b) => {
  const found = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    if (!Array.isArray(a[key]) || !Array.isArray(b[key])) {
      found[key] = ["(differs)"];
      continue;
    }
    const other = new Set(b[key]);
    found[key] = a[key]
      .filter((item) => !other.has(item))
      .map((item) => JSON.parse(item).name ?? JSON.parse(item).id ?? "?");
  }
  return found;
};

/** Fields whose contents after reachable emit differ between two orders. */
const differingState = (a, b) => {
  const fields = [];
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[field] ?? { entries: {}, unkeyed: [] };
    const y = b[field] ?? { entries: {}, unkeyed: [] };
    const keys = new Set([...Object.keys(x.entries), ...Object.keys(y.entries)]);
    let differs = [...keys].some((k) => x.entries[k] !== y.entries[k]);
    if (!differs) differs = JSON.stringify(x.unkeyed) !== JSON.stringify(y.unkeyed);
    if (differs) fields.push(field);
  }
  return fields;
};

const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Number(values.jobs) }, async () => {
    while (next < programs.length) {
      const entry = programs[next++];
      const name = basename(entry).replace(/\.ts$/, "");
      const dir = join(out, name);
      mkdirSync(dir, { recursive: true });
      const audit = values["no-audit"] ? "-" : join(dir, "audit.json");
      const base = await child(
        entry,
        join(dir, "base.ir.json"),
        "-",
        audit,
        join(dir, "base.state.json"),
      );
      if (!base.ok) {
        results.push({ program: name, status: "does not compile" });
        continue;
      }
      const diffs = {};
      const stateDiffs = {};
      let baseCanonical = null;
      for (const seed of seeds) {
        const run = await child(
          entry,
          join(dir, `seed${seed}.ir.json`),
          seed,
          "-",
          join(dir, `seed${seed}.state.json`),
        );
        if (!run.ok) {
          // A program that lowers in discovery order but not in this one
          // differs in content.
          diffs[seed] = { failed: run.stderr, content: { lowering: ["fails in this order"] } };
          continue;
        }
        const diff = differingFunctions(
          loadIr(join(dir, "base.ir.json")),
          loadIr(join(dir, `seed${seed}.ir.json`)),
        );
        const state = differingState(
          loadIr(join(dir, "base.state.json")),
          loadIr(join(dir, `seed${seed}.state.json`)),
        );
        if (state.length > 0) stateDiffs[seed] = state;
        if (diff.functions.length > 0 || diff.topLevel.length > 0) {
          baseCanonical ??= canonicalModule(loadIr(join(dir, "base.ir.json")));
          diff.content = contentDifferences(
            baseCanonical,
            canonicalModule(loadIr(join(dir, `seed${seed}.ir.json`))),
          );
          diffs[seed] = diff;
        }
      }
      const auditReport = audit === "-" ? {} : JSON.parse(readFileSync(audit, "utf8"));
      const changed = new Set(Object.values(diffs).flatMap((diff) => diff.functions ?? []));
      const attribution = {};
      for (const fn of changed) {
        const fields = Object.entries(auditReport)
          .filter(([, entry]) => entry.functions.includes(fn))
          .map(([field]) => field);
        attribution[fn] = fields;
      }
      results.push({
        program: name,
        status:
          Object.keys(diffs).length === 0
            ? "order-independent"
            : Object.values(diffs).some((diff) => Object.keys(diff.content ?? {}).length > 0)
              ? "order-dependent content"
              : "order-dependent names",
        diffs,
        attribution,
        sensitiveFields: Object.keys(auditReport),
        stateFields: [...new Set(Object.values(stateDiffs).flat())],
      });
      process.stderr.write(
        `${results.length}/${programs.length} ${name}: ${results.at(-1).status}\n`,
      );
    }
  }),
);
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));

const dependent = results.filter((r) => r.status.startsWith("order-dependent"));
const content = results.filter((r) => r.status === "order-dependent content");
const byField = new Map();
let unattributed = 0;
for (const r of dependent) {
  const fields = new Set(Object.values(r.attribution).flat());
  if (fields.size === 0) unattributed++;
  for (const field of fields) byField.set(field, (byField.get(field) ?? 0) + 1);
}
console.log(
  `programs ${results.length}: ${dependent.length} order-dependent (${content.length} beyond names and ids), ${results.filter((r) => r.status === "does not compile").length} do not compile`,
);
for (const r of content)
  console.log(
    `  ${r.program}: ${Object.values(r.diffs)
      .flatMap((diff) =>
        Object.entries(diff.content ?? {}).map(
          ([table, items]) => `${table}: ${items.slice(0, 4).join(", ")}`,
        ),
      )
      .slice(0, 3)
      .join("; ")}`,
  );
for (const [field, count] of [...byField].sort((a, b) => b[1] - a[1]))
  console.log(`${String(count).padStart(5)}  ${field}`);
console.log(`${String(unattributed).padStart(5)}  (no audited field)`);
const failing =
  values["fail-on"] === "names" ? dependent : values["fail-on"] === "content" ? content : [];
if (failing.length > 0) {
  console.log(`${failing.length} programs lower to different IR in another order`);
  process.exitCode = 1;
}
