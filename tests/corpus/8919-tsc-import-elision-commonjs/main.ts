// @tsc-emit
// A project that tsc compiles to CommonJS, with extensionless imports. The
// two classes name each other, but only one direction is a value import:
// `registry` imports `Entry` as a value, `entry` uses `Registry` in types
// only, so tsc drops that import and there is no cycle between the modules.
// A module imported only for its types is never loaded.
import { Registry } from "./registry";
import { Entry } from "./entry";
import { Options } from "./options";
import defaults, { Limits } from "./defaults";
import * as formats from "./formats";

const options: Options = { verbose: true };
const limits: Limits = { max: defaults.max };
const registry = new Registry();
registry.add(new Entry("a", registry));
registry.add(new Entry("b", registry));
console.log("main", options.verbose, limits.max, registry.names().join(","));
const style: formats.Style = "plain";
console.log(style);
