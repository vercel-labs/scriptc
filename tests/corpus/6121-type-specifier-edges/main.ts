// An inline `type` specifier keeps its module request under Node's type
// stripping: `export { type X } from` and `import { type X } from` both
// evaluate the named module, once, in source order. A cycle closed only by
// such an import binds nothing at runtime and runs like a side-effect
// import.
import { type Config } from "./config-barrel.ts";
import { start } from "./a.ts";

const config: Config = { name: "demo" };
console.log("main", config.name, start());
