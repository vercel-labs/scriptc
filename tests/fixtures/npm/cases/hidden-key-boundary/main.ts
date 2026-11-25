// A package whose values carry non-enumerable keys, typed by its own
// declarations: the schemas cross into typed code as native records and
// keep their hidden keys hidden, on the typed side and when they go back
// into the package.
import { text, count, optional, list, shape, kindOf, isKind, describe, check } from "kindkit";

const name = text({ description: "a name" });
const size = count();
const tags = list(text());
const entry = shape({ name, size: optional(size), tags }, { title: "Entry" });

console.log("json", JSON.stringify(entry));
console.log("keys", Object.keys(entry).join(","), "|", Object.keys(name).join(","), "|", Object.keys(size).join(","));
console.log("properties", Object.keys(entry.properties).join(","));
console.log("reads", name["~kind"], name.type, entry["~kind"], entry.type, entry.required.join(","));
console.log("nested", entry.properties.tags["~kind"], entry.properties.tags.items["~kind"], entry.properties.size["~optional"]);
for (const key in name) console.log("for-in", key);
console.log("values", Object.values(name).join(","));
console.log("entries", JSON.stringify(Object.entries(tags)));
console.log("has", "~kind" in name, Object.hasOwn(name, "~kind"), Object.getOwnPropertyNames(name).join(","));
console.log(name);
console.log(entry);

// The package reads the hidden keys of the values typed code hands back.
console.log("kinds", kindOf(name), kindOf(size), kindOf(tags), kindOf(entry), isKind(entry.properties.size, "Count"));
console.log(describe(name));
console.log(describe(entry));
console.log(describe(entry.properties.size));
console.log(
  "check",
  check(entry, { name: "a", tags: ["x", "y"] }),
  check(entry, { name: "a", size: 2, tags: [] }),
  check(entry, { name: 1, tags: [] }),
  check(entry, { name: "a", size: 1.5, tags: [] }),
  check(entry, { tags: [] }),
);

// A table of schemas, as a program with many commands builds at start.
const table = [name, text(), text({ title: "third" })];
console.log("table", JSON.stringify(table), table.map((schema) => Object.keys(schema).length).join(","));
const untyped: unknown = entry;
console.log("untyped", JSON.stringify(untyped), kindOf(untyped));
