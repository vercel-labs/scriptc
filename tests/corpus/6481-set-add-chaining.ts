// Set.prototype.add returns the Set, so its result can be chained,
// compared, stored and returned. Results nobody reads keep the plain
// statement form.
class Item {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

const seen = new Set<string>();
seen.add("a").add("b").add("a");
console.log(seen.size, [...seen].join(","));
console.log(seen.add("c") === seen, seen.has("c"));

const nodes = new Set<Item>();
const first = new Item("first");
const memo = new Item("memo");
nodes.add(first).add(memo);
console.log(nodes.size, nodes.has(first), nodes.has(memo));

function collect(values: number[]): Set<number> {
  const out = new Set<number>();
  for (const v of values) out.add(v);
  return out.add(-1);
}
console.log([...collect([3, 1, 3, 2])].join(" "));

const stored = seen.add("d");
console.log(stored === seen, stored.size);

let calls = 0;
function target(): Set<string> {
  calls++;
  return seen;
}
target().add("e").add("f");
console.log(calls, seen.size);

const flag = seen.size > 3;
const picked = flag ? seen.add("g") : new Set<string>();
console.log(picked === seen, seen.has("g"));

[1, 2, 2, 5].forEach((n) => nodes.add(new Item(`n${n}`)));
console.log(nodes.size);

// An arrow whose expression body is the add() returns the Set.
const tags = new Set<string>();
const tag = (t: string) => tags.add(t);
console.log(tag("x").size, tag("y") === tags);
const typedTag = (t: string): Set<string> => tags.add(t);
console.log(typedTag("z").has("z"));
const results = ["p", "q"].map((t) => tags.add(t));
console.log(results.length, results[1] === tags, tags.size);
["r", "s"].forEach((t) => tags.add(t));
console.log([...tags].join(","));
