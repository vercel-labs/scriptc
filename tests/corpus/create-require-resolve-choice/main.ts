// A call whose callee chooses between an injected function and a
// createRequire loader's resolve: `(options.resolve ?? loader.resolve)(id)`.
// In TypeScript source the loader's resolve exists only as the callee of a
// direct call, which resolves at build time, so the call is the choice
// between two calls: through the injected value, or the direct call.
import { createRequire } from "node:module";
import { basename, dirname } from "node:path";

const loader = createRequire(import.meta.url);

interface Options {
  resolve?: (specifier: string) => string;
  lookup?: (request: string) => string[] | null;
}

function documentPath(options: Options = {}): string {
  return (options.resolve ?? loader.resolve)("./cfg.json");
}
console.log(basename(documentPath()), basename(dirname(documentPath())));
console.log(documentPath({ resolve: (specifier) => `/injected/${specifier}` }));
console.log(documentPath({}) === loader.resolve("./cfg.json"));

// A builtin id, and the choice spelled `||`.
function builtinId(options: Options): string {
  return (options.resolve || loader.resolve)("node:path");
}
console.log(builtinId({}), builtinId({ resolve: (specifier) => specifier.toUpperCase() }));

// Nothing resolves: Node's catchable MODULE_NOT_FOUND, only on the loader's
// side of the choice.
function missing(options: Options = {}): string {
  try {
    return (options.resolve ?? loader.resolve)("no-such-package-anywhere-on-disk");
  } catch (error) {
    return (error as { code?: string }).code ?? "no code";
  }
}
console.log(missing(), missing({ resolve: () => "found" }));

// A const names the request; the result is an ordinary string.
const REQUEST = "./cfg.json";
function upperName(options: Options = {}): string {
  const path: string = (options.resolve ?? loader.resolve)(REQUEST);
  return basename(path).toUpperCase();
}
console.log(upperName(), upperName({ resolve: (specifier) => specifier + ".bak" }));

// The left operand is evaluated once, before the call.
let reads = 0;
function nextOptions(inject: boolean): Options {
  reads++;
  return inject ? { resolve: (specifier) => `#${reads}:${specifier}` } : {};
}
console.log((nextOptions(true).resolve ?? loader.resolve)("node:fs"), reads);
console.log((nextOptions(false).resolve ?? loader.resolve)("node:fs"), reads);

// resolve.paths through the same choice.
function searchPaths(options: Options, injected: boolean): string {
  const builtin = (options.lookup ?? loader.resolve.paths)("node:path");
  const relative = (options.lookup ?? loader.resolve.paths)("./cfg.json");
  return `${builtin === null ? "null" : builtin.length} ${
    relative === null ? "null" : injected ? relative.join("|") : relative.length
  }`;
}
console.log(searchPaths({}, false));
console.log(searchPaths({ lookup: (request) => [request, "x"] }, true));
