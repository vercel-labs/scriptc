#!/usr/bin/env node
// The member census of every supported builtin module, taken from the pinned
// Node release: the CommonJS exports object's enumerable keys
// (Object.keys order), its own property names
// (Object.getOwnPropertyNames order), and the names it inherits from its
// prototype chain. The compiler answers `in`, Object.keys and
// hasOwnProperty over a builtin module namespace from this table, so every
// module reports Node's exact member surface instead of the ambient subset
// the lowerings happen to implement.
//
// The census also records what each member IS in Node: `typeof` of every own
// member, and `length` of the functions; the same for the own properties of
// the global object and for the members of the global objects (process,
// console, performance, crypto, navigator). A JavaScript source that reads a
// Node value native code has no value for is answered from these tables: a
// name Node does not define reads as Node reads it, a function is a function
// value, anything else is refused by name (node-values.ts).
//
//   node scripts/gen-builtin-module-members.mjs          regenerate the table
//   node scripts/gen-builtin-module-members.mjs --check  verify only
import { fork, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Every name on `value` and on its prototype chain, own names first. */
function chainNames(value) {
  const seen = new Set();
  for (
    let object = value;
    object !== null && object !== undefined;
    object = Object.getPrototypeOf(object)
  ) {
    for (const name of Object.getOwnPropertyNames(object)) seen.add(name);
  }
  return [...seen];
}

/** `name=typeof` for each of `names` on `object` (`function:<length>` for a
 * function, "throws" for a getter that throws), in a form a child process
 * can send to its parent. */
function typeEntries(object, names) {
  return names.map((name) => {
    let type;
    try {
      const value = object[name];
      type = typeof value === "function" ? `function:${value.length}` : typeof value;
    } catch {
      type = "throws";
    }
    return `${name}=${type}`;
  });
}

// Reading every member reads the deprecated ones too, and Node warns about
// each on stderr. The warnings are left alone: silencing them would change the
// process object this script describes.
//
// The two helper runs below see the process object as other processes see
// it: a child with an IPC channel re-enters this script here, and a CommonJS
// entry is written to a temporary file.
if (process.argv[2] === "--process-members") {
  process.send(typeEntries(process, chainNames(process)), () => process.exit(0));
  await new Promise(() => {});
}

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(
  root,
  "packages/compiler/src/frontend/lowering/builtin-module-members.generated.ts",
);
const checkOnly = process.argv.includes("--check");
const pinned = readFileSync(join(root, ".node-version"), "utf8").trim();
if (process.version !== `v${pinned}`) {
  throw new Error(`run with Node v${pinned} (this is ${process.version})`);
}
const { SUPPORTED_BUILTIN_MODULES } =
  await import("../packages/compiler/src/frontend/builtin-modules.ts");

const require = createRequire(import.meta.url);

/** Every own name on the prototype chain below `value`, in chain order,
 * without the names `value` itself owns. `in` is the only reader, and it
 * asks about presence, not order. */
function inheritedNames(value) {
  const seen = new Set(Object.getOwnPropertyNames(value));
  const inherited = [];
  for (
    let proto = Object.getPrototypeOf(value);
    proto !== null;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name)) continue;
      seen.add(name);
      inherited.push(name);
    }
  }
  return inherited;
}

/** The census text of what the members `names` of `object` are: the
 * functions as `name=length`, the others as `name=typeof` ("object" for
 * null, "throws" for a getter that throws when it is read), each list
 * joined by spaces. Member names never contain a space or `=`. */
function describeMembers(object, names, platformDependent = []) {
  const functions = [];
  const values = [];
  for (const entry of typeEntries(object, names)) {
    const parts = entry.split("=");
    const [name, type] = parts;
    if (parts.length !== 2 || /\s/.test(name))
      throw new Error(`member name ${JSON.stringify(name)} does not fit the census encoding`);
    if (platformDependent.includes(name)) values.push(`${name}=platform`);
    else if (type.startsWith("function:")) functions.push(`${name}=${type.slice(9)}`);
    else values.push(`${name}=${type}`);
  }
  return { functions: functions.join(" "), values: values.join(" ") };
}

// Members whose value in Node depends on the operating system: recorded as
// "platform", so the table is the same wherever it is generated and the
// compiler refuses a read of one by name instead of answering for the
// platform the table happened to be taken on. `fs.lchmod` is a function on
// macOS and undefined elsewhere.
const PLATFORM_DEPENDENT = { fs: ["lchmod", "lchmodSync"] };

const census = [];
for (const module of SUPPORTED_BUILTIN_MODULES) {
  const exportsObject = require(`node:${module}`);
  const ownNames = Object.getOwnPropertyNames(exportsObject);
  census.push({
    module,
    callable: typeof exportsObject === "function",
    keys: Object.keys(exportsObject),
    ownNames,
    inherited: inheritedNames(exportsObject),
    ...describeMembers(exportsObject, ownNames, PLATFORM_DEPENDENT[module]),
  });
}

// The global object's own properties, and the members of the global objects
// that are Node's (the ECMAScript namespace objects have their own
// lowerings and are not Node's to describe).
const ECMASCRIPT_NAMESPACES = new Set([
  "globalThis",
  "global",
  "Atomics",
  "Intl",
  "JSON",
  "Math",
  "Reflect",
  "WebAssembly",
]);
const globalNames = Object.getOwnPropertyNames(globalThis);
const globals = describeMembers(globalThis, globalNames);
const globalObjects = [];
for (const name of globalNames) {
  const value = globalThis[name];
  if (typeof value !== "object" || value === null || ECMASCRIPT_NAMESPACES.has(name)) continue;
  globalObjects.push({ name, ...describeMembers(value, chainNames(value)) });
}
// The statics of the global functions and classes that have any (`URL.canParse`,
// `AbortSignal.timeout`, `Buffer.poolSize`): their own properties, with
// `prototype`. `length` and `name` are every function's and are answered by
// the function value itself.
for (const name of globalNames) {
  const value = globalThis[name];
  if (typeof value !== "function") continue;
  const statics = Object.getOwnPropertyNames(value).filter(
    (member) => !["length", "name", "arguments", "caller"].includes(member),
  );
  if (statics.some((member) => member !== "prototype"))
    globalObjects.push({ name, ...describeMembers(value, statics) });
}
// crypto.subtle is the one object of that kind a level down: a class
// instance whose methods programs destructure (`const { subtle } = crypto`).
globalObjects.push({
  name: "crypto.subtle",
  ...describeMembers(globalThis.crypto.subtle, chainNames(globalThis.crypto.subtle)),
});

// Members the process object has only in some processes: with an IPC channel
// (a forked child), and when the entry module is CommonJS.
const here = new Map(typeEntries(process, chainNames(process)).map((e) => e.split("=")));
const onlyThere = (found) =>
  found
    .map((e) => e.split("="))
    .filter(([name, type]) => here.get(name) !== type)
    .map(([name]) => name)
    .sort()
    .join(" ");
const ipcMembers = await new Promise((resolve, reject) => {
  const child = fork(fileURLToPath(import.meta.url), ["--process-members"], { stdio: "ignore" });
  child.once("message", (found) => resolve(onlyThere(found)));
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code !== 0) reject(new Error(`the IPC census child exited with ${code}`));
  });
});
const scratch = mkdtempSync(join(tmpdir(), "scriptc-census-"));
let commonJsMembers;
try {
  const entry = join(scratch, "entry.cjs");
  writeFileSync(
    entry,
    `${chainNames}\n${typeEntries}\nconsole.log(JSON.stringify(typeEntries(process, chainNames(process))));\n`,
  );
  const run = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (run.status !== 0) throw new Error(`the CommonJS census run failed: ${run.stderr}`);
  commonJsMembers = onlyThere(JSON.parse(run.stdout));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const literal = (names) => `[${names.map((name) => JSON.stringify(name)).join(", ")}]`;
const entries = census.map(
  ({
    module,
    callable,
    keys,
    ownNames,
    inherited,
    functions,
    values,
  }) => `  ${JSON.stringify(module)}: {
    callable: ${callable},
    keys: ${literal(keys)},
    ownNames: ${literal(ownNames)},
    inherited: ${literal(inherited)},
    functions: ${JSON.stringify(functions)},
    values: ${JSON.stringify(values)},
  },`,
);
const objectEntries = globalObjects.map(
  ({ name, functions, values }) => `  ${JSON.stringify(name)}: {
    functions: ${JSON.stringify(functions)},
    values: ${JSON.stringify(values)},
  },`,
);
const lines = [
  `/* Generated by scripts/gen-builtin-module-members.mjs from Node v${pinned}. Do not edit. */`,
  "",
  "/** One builtin module's CommonJS member surface. */",
  "export interface BuiltinModuleMemberCensus {",
  "  /** The module.exports value is callable (node:assert, node:events, node:module, node:test). */",
  "  readonly callable: boolean;",
  "  /** Object.keys of the exports object, in Node's order. */",
  "  readonly keys: readonly string[];",
  "  /** Object.getOwnPropertyNames of the exports object, in Node's order. */",
  "  readonly ownNames: readonly string[];",
  "  /** Names inherited from the exports object's prototype chain. */",
  "  readonly inherited: readonly string[];",
  "  /** The own members that are functions, each with Node's `length`: `name=length`, space-separated. */",
  "  readonly functions: string;",
  '  /** `typeof` of every other own member: `name=typeof`, space-separated ("throws" for a getter that throws). */',
  "  readonly values: string;",
  "}",
  "",
  "/** The CommonJS exports object of every supported builtin module. */",
  "export const BUILTIN_MODULE_MEMBERS: Readonly<Record<string, BuiltinModuleMemberCensus>> = {",
  ...entries,
  "};",
  "",
  "/** What the members of one Node object are, in the encoding above. */",
  "export interface NodeMemberCensus {",
  "  readonly functions: string;",
  "  readonly values: string;",
  "}",
  "",
  "/** The global object's own properties in Node. A name absent here is one Node does not define by default. */",
  "export const NODE_GLOBALS: NodeMemberCensus = {",
  `  functions: ${JSON.stringify(globals.functions)},`,
  `  values: ${JSON.stringify(globals.values)},`,
  "};",
  "",
  "/** The members, own and inherited, of the global objects that are Node's, and the own properties (statics and `prototype`) of the global functions that have statics. */",
  "export const NODE_GLOBAL_OBJECT_MEMBERS: Readonly<Record<string, NodeMemberCensus>> = {",
  ...objectEntries,
  "};",
  "",
  "/** Object.prototype's own names, space-separated: every object above inherits them. */",
  `export const NODE_OBJECT_PROTOTYPE_MEMBERS = ${JSON.stringify(Object.getOwnPropertyNames(Object.prototype).join(" "))};`,
  "",
  "/** Members the process object has only with an IPC channel, space-separated. */",
  `export const NODE_PROCESS_IPC_MEMBERS = ${JSON.stringify(ipcMembers)};`,
  "",
  "/** Members the process object has only when the entry module is CommonJS, space-separated. */",
  `export const NODE_PROCESS_COMMONJS_MAIN_MEMBERS = ${JSON.stringify(commonJsMembers)};`,
  "",
];
const text = lines.join("\n");
if (checkOnly) {
  if (readFileSync(out, "utf8") !== text) {
    console.error(`${out} is stale: run node scripts/gen-builtin-module-members.mjs`);
    process.exit(1);
  }
  console.log(`${out} is current`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
