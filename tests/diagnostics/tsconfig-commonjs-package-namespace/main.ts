// A CommonJS project types a package through its `require` entry, where
// `export =` merges a function with a namespace of types. An ES module
// resolves the `import` entry, whose declarations have no such namespace.
import Kit from "argv-kit";

export function parse(): Kit.Options {
  return Kit(["--x"]);
}

console.log(parse().raw.length);
