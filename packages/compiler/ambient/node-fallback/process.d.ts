/* Node's process module default export is the global process object. These
 * declaration aliases let the ESM spelling typecheck against the same
 * deliberately narrow fallback surface when @types/node is absent. */
declare module "process" {
  export = process;
}

declare module "node:process" {
  import process = require("process");
  export = process;
}
