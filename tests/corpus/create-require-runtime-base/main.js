// A require whose base is only known at run time anchors no build-time
// resolution: the loader is a function value whose calls defer to run
// time. The factory destructured from the node:module namespace is the
// bundled CommonJS twin of the named import.
import { createRequire } from "node:module";

const makeRequire = createRequire("/generated/base/");
console.log("runtime:", typeof makeRequire);

const { createRequire: factory } = createRequire(import.meta.url)("node:module");
const anchored = factory(import.meta.url);
console.log("factory:", typeof factory, typeof anchored);
console.log("anchored again:", typeof anchored === "function");
