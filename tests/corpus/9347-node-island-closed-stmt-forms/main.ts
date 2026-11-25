// @requires-libnode
// The forms an island-closed statement takes: a constant the island
// evaluates as an operand, a construction, a call as an argument, object
// and array literals, a type assertion. And two that are not closed and
// stay as they were: a native value as an operand, and a call whose value
// the program computes with.
import { Entry, type Plugin, registry } from "plug-kit";

const made = registry.make("gamma");
registry.register("gamma", made);
new Entry("solo");
registry.register("inline", registry.make("nested"));
registry.configure({ limit: 3, tags: ["a", "b"] });
(registry.register as (name: string, plugin: Plugin) => void)("cast", made!);

const label: string = ["na", "tive"].join("");
registry.register(label, made);
void registry.setLimit(registry.limit() + 1);

console.log(registry.list());
console.log(registry.count(), registry.limit());
