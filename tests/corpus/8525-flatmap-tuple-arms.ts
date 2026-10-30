// A `flatMap` callback whose body is a block and whose enclosing call has a
// contextual array type infers a TUPLE union (`return v ? [pair] : []`
// infers `[] | [pair]`), so one arm is a tuple rather than an array. The
// loop appends a tuple arm's fields in order, exactly as it appends an array
// arm's elements, and an empty arm appends nothing.
interface Namespace {
  name: string;
  description?: string;
}
interface Tool {
  name: string;
  label?: string;
}
interface Loadout {
  callable: Tool[];
  getNamespace(name: string): Namespace | undefined;
}

function pairsOf(loadout: Loadout): (readonly [string, Namespace])[] {
  return loadout.callable.flatMap((tool) => {
    const namespace = loadout.getNamespace(tool.name);
    return namespace ? [[tool.name, namespace] as const] : [];
  });
}

const loadout: Loadout = {
  callable: [{ name: "docs" }, { name: "skip", label: "S" }, { name: "notes" }],
  getNamespace: (name) =>
    name === "skip" ? undefined : { name: name.toUpperCase(), description: `${name} ns` },
};
const pairs = pairsOf(loadout);
console.log("pairs", pairs.length);
for (const [key, namespace] of pairs) console.log("pair", key, namespace.name, namespace.description);
console.log("map size", new Map(pairsOf(loadout)).size);

// A two-field tuple arm contributes both fields, in order.
function doubled(words: (string | undefined)[]): string[] {
  return words.flatMap((word) => (word ? [word, word.toUpperCase()] : []));
}
console.log("doubled", doubled(["a", undefined, "bc"]).join(","));

// An array arm beside a scalar arm keeps the per-value flatten decision.
function pieces(parts: (string | string[])[]): string[] {
  return parts.flatMap((part) => (Array.isArray(part) ? part : [part]));
}
console.log("pieces", pieces(["x", ["y", "z"], "w"]).join("-"));
