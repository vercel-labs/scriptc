// @scriptc/node — the Node.js implementation.
//
// scriptc builds lower call() and callSync() to calls into Node.js loaded
// into the program (packages/runtime/src/scr_node_island.c and its
// bootstrap, scr_node_island_host.cjs). Under Node.js they run directly,
// with the same copies at the boundary, so a program prints the same
// either way. Keep the two in step: every message and copy rule here has
// its twin in the bootstrap.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Error classes that cross as copies, at the host's kind index.
const ERROR_CLASSES = [
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  undefined,
  ReferenceError,
  EvalError,
  URIError,
];
const ERROR_KINDS = [
  [TypeError, 1],
  [RangeError, 2],
  [SyntaxError, 3],
  [ReferenceError, 5],
  [EvalError, 6],
  [URIError, 7],
];

/** The file of the code that called `api`. */
function callerFile(api) {
  const savedPrepare = Error.prepareStackTrace;
  const savedLimit = Error.stackTraceLimit;
  let sites;
  try {
    Error.stackTraceLimit = 1;
    Error.prepareStackTrace = (_error, callSites) => callSites;
    const holder = {};
    Error.captureStackTrace(holder, api);
    sites = holder.stack;
  } finally {
    Error.prepareStackTrace = savedPrepare;
    Error.stackTraceLimit = savedLimit;
  }
  const name = Array.isArray(sites) && sites.length > 0 ? sites[0].getFileName() : undefined;
  if (typeof name !== "string")
    throw new Error("@scriptc/node: cannot determine the calling module");
  return name.startsWith("file:") ? fileURLToPath(name) : name;
}

const requires = new Map();

function exportedFunction(file, specifier, name) {
  let load = requires.get(file);
  if (load === undefined) {
    load = createRequire(file);
    requires.set(file, load);
  }
  const namespace = load(specifier);
  const fn = namespace === null || namespace === undefined ? undefined : namespace[name];
  if (typeof fn !== "function")
    throw new TypeError(`'${name}' exported by '${specifier}' is not a function`);
  return { fn, namespace };
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function errorKind(error) {
  for (const [constructor, kind] of ERROR_KINDS) if (error instanceof constructor) return kind;
  return 0;
}

/** The copy of a thrown value that the caller sees. */
function copyThrown(error) {
  if (error instanceof Error) {
    const copy = new ERROR_CLASSES[errorKind(error)](String(error.message));
    if (typeof error.code === "string") copy.code = error.code;
    return copy;
  }
  let text;
  try {
    text = JSON.stringify(error);
  } catch {
    text = undefined;
  }
  return text === undefined ? undefined : JSON.parse(text);
}

/** The JSON copy of a result; throws what JSON.stringify throws. */
function copyResult(value) {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

function copyArgs(args) {
  return JSON.parse(JSON.stringify(args));
}

export function callSync(specifier, name, ...args) {
  const file = callerFile(callSync);
  const copied = copyArgs(args);
  let result;
  try {
    const { fn, namespace } = exportedFunction(file, specifier, name);
    result = Reflect.apply(fn, namespace, copied);
    if (isThenable(result)) {
      // The promise is dropped: its rejection must not end the process.
      Promise.resolve(result).catch(() => {});
      throw new TypeError(
        `callSync: '${name}' exported by '${specifier}' returned a promise; use call() for asynchronous functions`,
      );
    }
    return copyResult(result);
  } catch (error) {
    throw copyThrown(error);
  }
}

export async function call(specifier, name, ...args) {
  const file = callerFile(call);
  const copied = copyArgs(args);
  try {
    const { fn, namespace } = exportedFunction(file, specifier, name);
    return copyResult(await Reflect.apply(fn, namespace, copied));
  } catch (error) {
    throw copyThrown(error);
  }
}

/** requireModule(specifier): the module's exports, by reference. */
export function requireModule(specifier) {
  return createRequire(callerFile(requireModule))(specifier);
}
