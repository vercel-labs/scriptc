"use strict";
/* The Node island bootstrap: the main script of the Node environment that
 * scr_node_island.c loads into the process on the first call into Node.
 * scr_node_island_host.h embeds this file as a C string; regenerate it
 * with `node scripts/node-island-host.mjs` after every change.
 *
 * The libnode bridge (scr_node_bridge.cc) installs a native `settle`
 * function as globalThis.__scriptcNodeIslandHost before this script runs,
 * and takes the dispatcher this script leaves as
 * globalThis.__scriptcNodeIsland afterwards; it deletes both globals.
 *
 * A copy of the call semantics lives in packages/node/index.js, which runs
 * them in-process under Node: both must produce the same results, errors
 * and messages. Outcomes are "R<json>" (returned; "R" alone is undefined)
 * or "T<json>" (threw), the encoding of scr_node_bridge.h. */
const { createRequire, registerHooks } = require("node:module");

const nativeHost = globalThis.__scriptcNodeIslandHost;

// The program's island module tree (scr_node_island.c prefixes this script
// with its root, then the bridge removes the global): modules resolve only
// to files inside it, never to a file elsewhere on the machine.
const islandRoot = globalThis.__scriptcNodeIslandRoot;
delete globalThis.__scriptcNodeIslandRoot;
if (typeof islandRoot === "string" && islandRoot !== "/") {
  const { realpathSync } = require("node:fs");
  const { sep } = require("node:path");
  const { fileURLToPath } = require("node:url");
  const root = realpathSync(islandRoot);
  const inside = root.endsWith(sep) ? root : root + sep;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith("file:") && !fileURLToPath(result.url).startsWith(inside)) {
        const error = new Error(
          `Cannot find module '${specifier}': it is not one of the modules this program ships`,
        );
        error.code = "MODULE_NOT_FOUND";
        throw error;
      }
      return result;
    },
  });
}

// Error classes that cross as copies, at their scr_error.h kind index.
const ERROR_KINDS = [
  [TypeError, 1],
  [RangeError, 2],
  [SyntaxError, 3],
  [ReferenceError, 5],
  [EvalError, 6],
  [URIError, 7],
];

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

function invokeSync(file, specifier, name, args) {
  const { fn, namespace } = exportedFunction(file, specifier, name);
  const result = Reflect.apply(fn, namespace, args);
  if (isThenable(result)) {
    // The promise is dropped: its rejection must not end the process.
    Promise.resolve(result).catch(() => {});
    throw new TypeError(
      `callSync: '${name}' exported by '${specifier}' returned a promise; use call() for asynchronous functions`,
    );
  }
  return result;
}

async function invokeAsync(file, specifier, name, args) {
  const { fn, namespace } = exportedFunction(file, specifier, name);
  return await Reflect.apply(fn, namespace, args);
}

function errorKind(error) {
  for (const [constructor, kind] of ERROR_KINDS) if (error instanceof constructor) return kind;
  return 0;
}

// A thrown value crosses as a copy: an Error as its nearest intrinsic
// class with its message and string code, anything else as JSON data. An
// error whose class, message or code cannot be read crosses as an Error
// with an empty message.
function thrown(error) {
  try {
    return thrownCopy(error);
  } catch {
    return 'T{"error":{"kind":0,"message":""}}';
  }
}

function thrownCopy(error) {
  if (error instanceof Error) {
    const copy = { kind: errorKind(error), message: String(error.message) };
    if (typeof error.code === "string") copy.code = error.code;
    return `T${JSON.stringify({ error: copy })}`;
  }
  let text;
  try {
    text = JSON.stringify(error);
  } catch {
    text = undefined;
  }
  return text === undefined ? 'T{"undefined":true}' : `T{"value":${text}}`;
}

function returned(result) {
  let text;
  try {
    text = JSON.stringify(result);
  } catch (error) {
    return thrown(error);
  }
  return text === undefined ? "R" : `R${text}`;
}

function call(id, sync, file, specifier, name, argsJson) {
  const args = JSON.parse(argsJson);
  if (sync) {
    let result;
    try {
      result = invokeSync(file, specifier, name, args);
    } catch (error) {
      return thrown(error);
    }
    return returned(result);
  }
  invokeAsync(file, specifier, name, args).then(
    (result) => nativeHost.settle(id, returned(result)),
    (error) => nativeHost.settle(id, thrown(error)),
  );
  return undefined;
}

// Writes reach the shared stdout and stderr before control returns to the
// program, as the program's own writes do.
for (const stream of [process.stdout, process.stderr]) {
  if (stream._handle && typeof stream._handle.setBlocking === "function")
    stream._handle.setBlocking(true);
}

// The program ends with `code` (the bridge then runs Node's loop to its
// end, which emits 'beforeExit' and 'exit'): Node's process shares it, as
// it shares one process under Node.
function finish(code) {
  if (code !== 0) process.exitCode = code;
}

// process.execPath is this program, not a node executable: a fork without
// an execPath of its own would start the program again.
const childProcess = require("node:child_process");
const nodeFork = childProcess.fork;
childProcess.fork = function fork(modulePath, args, options) {
  const forkOptions = Array.isArray(args) ? options : args;
  const execPath =
    forkOptions === null || typeof forkOptions !== "object" ? undefined : forkOptions.execPath;
  if (execPath === undefined || execPath === process.execPath) {
    throw new Error(
      "child_process.fork() in a Node island needs options.execPath (a node executable): process.execPath is this program",
    );
  }
  return Reflect.apply(nodeFork, this, arguments);
};
require("node:module").syncBuiltinESMExports();

globalThis.__scriptcNodeIsland = { call, finish };
