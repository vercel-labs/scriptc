// createRequire uses Node's synchronous require(esm) path for this
// syntax-detected workspace package. Node loads it without emitting the
// ESM loader's MODULE_TYPELESS_PACKAGE_JSON warning.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const workspace = require("wstypeless") as any;

console.log(workspace.describe(21) as string);
