import YAML from "./browser.ts";
import * as all from "./browser.ts";
import * as dist from "./dist.ts";
import { CST } from "./dist.ts";

// The default export of the re-exporting module is the inner module's
// namespace object: same members, same object identity.
console.log(Object.keys(YAML).join(","));
console.log(YAML.parse("abcd"), YAML.VERSION, YAML.CST.parseNode("x"));
console.log(typeof YAML, typeof YAML.CST, typeof YAML.CST.parseNode);

// A namespace import of the re-exporting module carries its own resolved
// exports: its named re-export, its `export *` forwardings, and default.
console.log(Object.keys(all).join(","));
console.log(all.parse("ab"), all.VERSION, all.CST.parseOptions.pretty);
console.log(typeof all.default, all.default === YAML, all.default === dist);

// A namespace object re-exported under a name stays the inner module's
// namespace object.
console.log(Object.keys(CST).join(","), CST === YAML.CST);
console.log(CST.parseNode("y"), dist.CST.parseNode("z"), dist.CST === CST);

// Namespace objects pass through storage and typed-dynamic code intact.
const holder = { ns: YAML };
function identity<T>(value: T): T {
  return value;
}
const passed = identity(YAML);
console.log(holder.ns.parse("abc"), passed.parse("abc"));
console.log(passed === YAML, holder.ns === YAML, typeof passed.parse);
