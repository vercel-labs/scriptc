// @requires-libnode
// An island-closed constant that reads state another island module's load
// changes, in a run that loads that module first. The build's probe
// evaluated the constant before the plugin (the dynamic import has no place
// in the program's static order), so its snapshot says 0. A snapshot holds
// only in a run that registered, before it, exactly the loads the probe
// evaluated before it; this run loads the plugin's package first, so that
// package and then the constant evaluate where they are written.
import { registry } from "reg-kit";

console.log("start");
if (process.argv.length < 99) {
  const plugin = await import("./plugin.ts");
  console.log("plugin", plugin.name);
}
const count: number = registry.count();
console.log("count", count, registry.list());
