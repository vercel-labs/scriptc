// The bundled conditional spelling: `createRequire ? createRequire(...) :
// undefined` folds to the true arm (the import binding is always a
// function), so the binding erases and its calls resolve at build time.
import { createRequire } from "node:module";

const require = createRequire ? createRequire(import.meta.url) : undefined;

console.log("type:", typeof require);
console.log("value:", require("./data.json").key);
console.log("again:", typeof require === "function");
