// @requires-libnode
// Island values in the forms real packages hand back: arrays and Maps the
// island does not declare stay handles (members, indexing, methods, spread,
// passing back), String()/templates/+ run the island object's own
// toString/valueOf/Symbol.toPrimitive, compound assignment and optional
// chaining on island members, and spread arguments into island calls.
import { Money, Tagged, Version, config, count, fresh, helper, join, list, maybe, optional, push, table } from "handle-pkg";

const names = list();
console.log(names.length, names[0], names.join(","), names.includes("grace"));
console.log(count(names), names === list() ? "same" : "different");
push("barbara");
console.log("after push", names.length, names[3]);
const upper = fresh();
console.log(upper.map((n) => n.length).join(" "), upper.indexOf("LINUS"));
const copied: string[] = [...names];
copied.push("local");
console.log(copied.length, names.length, copied.join("|"));
console.log(join(...names), join("x", ...upper, "y"));
const local = ["p", "q"];
console.log(join(...local), count(names));
const t = table();
console.log(t.size, t.get("a"), t.has("z"));

const v = new Version("3.4");
console.log(String(v), `${v}`, "v=" + v, v + "!");
const m = new Money(250);
console.log(+m + 1, String(m), `${m}`, Number(m) * 2);
const tag = new Tagged();
console.log(String(tag), `${tag}`, tag + "", Number(tag));

v.hits += 2;
v.hits *= 5;
v.label += "-beta";
console.log(v.hits, v.label);
const key = "hits";
v[key] -= 3;
console.log(v.hits);

const some = maybe(true);
const none = maybe(false);
console.log(some?.major, none?.major, some?.minor ?? -1, none?.minor ?? -1);
console.log(config.nested?.depth, optional(true)?.nested.depth, optional(false)?.nested.depth);
console.log(helper.greet?.("ada"), helper.missing?.("bob"));
