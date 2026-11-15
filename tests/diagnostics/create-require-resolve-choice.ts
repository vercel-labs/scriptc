// `(options.resolve ?? loader.resolve)("<literal>")` compiles in TypeScript
// source (corpus create-require-resolve-choice): the loader's resolve is
// the callee of a direct call there. What stays refused is the function
// itself as a value, and a request the build cannot name.
import { createRequire } from "node:module";

const loader = createRequire(import.meta.url);

interface Options {
  resolve?: (specifier: string) => string;
}

// Read into a binding: no argument list is at hand, so this needs the value.
function stored(options: Options): string {
  const pick = options.resolve ?? loader.resolve;
  return pick("node:path");
}

// A request computed at run time.
function computed(options: Options, request: string): string {
  return (options.resolve ?? loader.resolve)(request);
}

// A conditional chooses the callee: only `??` and `||` distribute the call.
function conditional(options: Options): string {
  return (options.resolve ? options.resolve : loader.resolve)("node:path");
}

// Read into a typed slot.
function typed(): string {
  const resolve: (specifier: string) => string = loader.resolve;
  return resolve("node:path");
}

console.log(stored({}), computed({}, process.argv[2] ?? "node:path"), conditional({}), typed());
