// Object.values over dictionaries of `object` and `unknown`, chained into
// array methods: the lists are native, the callbacks are called directly,
// and every answer is Node's.
type Dict = Record<string, object>;
type Groups = Record<string, Dict>;

const groups: Groups = {
  metric: {
    "part:a": { kind: "part", id: "a", size: 3 },
    "label:b": { kind: "label", id: "b" },
    "part:c": { kind: "part", id: "c", size: 5, tags: ["x", "y"] },
  },
  imperial: {
    "sketch:d": { kind: "sketch", id: "d", output: ["image"] },
    "part:e": { id: "e", size: 7 },
  },
  empty: {},
};

function flatten(groups: Groups, kind: string): Dict {
  return Object.fromEntries(
    Object.values(groups)
      .flatMap((entries) => Object.values(entries))
      .filter((entry) => (entry as { kind?: unknown }).kind === kind)
      .map((entry) => [(entry as { id: string }).id, entry]),
  );
}

const parts = flatten(groups, "part");
console.log(Object.keys(parts).join(","), JSON.stringify(parts));
console.log(JSON.stringify(flatten(groups, "sketch")), JSON.stringify(flatten(groups, "none")));
// The values keep their identity through the chain.
console.log(parts["a"] === groups["metric"]!["part:a"], parts["c"] === groups["metric"]!["part:c"]);

// Each consumer, over a dictionary of objects.
const dict: Dict = groups["metric"]!;
const ids = Object.values(dict).map((value) => (value as { id: string }).id);
console.log(ids.join("+"), ids.length);
let seen = "";
Object.values(dict).forEach((value, index) => {
  seen += `${index}:${(value as { kind: string }).kind};`;
});
console.log(seen);
console.log(
  Object.values(dict).every((value) => typeof value === "object"),
  Object.values(dict).some((value) => (value as { size?: number }).size === 5),
  Object.values(dict).findIndex((value) => (value as { id: string }).id === "b"),
  Object.values(dict).findLastIndex((value) => (value as { kind: string }).kind === "part"),
);
console.log(
  Object.values(dict).reduce((sum, value) => sum + ((value as { size?: number }).size ?? 0), 0),
  Object.values(dict).reduceRight((text, value) => text + (value as { id: string }).id, ""),
);
console.log(
  Object.values(dict)
    .filter((value) => "size" in value)
    .map((value) => (value as { size: number }).size * 2)
    .join("/"),
);
// The index and the list itself as callback parameters.
console.log(
  Object.values(dict)
    .map((value, index, all) => `${index}/${all.length}/${all[index] === value}`)
    .join(" "),
);
console.log(
  Object.values(groups)
    .flatMap((entries, index) => Object.values(entries).map((entry) => `${index}${(entry as { id: string }).id}`))
    .join(""),
);

// The list a chain ends with is an ordinary array.
function kept(d: Dict): object[] {
  return Object.values(d).filter((value) => (value as { kind: string }).kind === "part");
}
const list = kept(dict);
list.push({ id: "pushed" });
console.log(Array.isArray(list), list.length, JSON.stringify(list), list[0] === dict["part:a"]);
const lists: object[][] = [kept(dict), Object.values(dict).map((value) => value)];
console.log(lists.map((each) => each.length).join(","), lists[0] !== lists[1]);

// Values of every kind in an `unknown` dictionary.
const mixed: Record<string, unknown> = {
  n: 1.5,
  s: "text",
  t: true,
  z: null,
  u: undefined,
  a: [1, [2, 3]],
  o: { deep: { er: 1 } },
  big: 12n,
};
console.log(
  Object.values(mixed)
    .map((value) => (typeof value === "bigint" ? `${value}n` : (JSON.stringify(value) ?? "undefined")))
    .join("|"),
);
console.log(
  Object.values(mixed).filter((value) => value !== null && typeof value === "object").length,
  Object.values(mixed).flatMap((value) => (Array.isArray(value) ? value : [value])).length,
);

// A callback that throws stops the walk where Node stops it.
let visited = 0;
try {
  Object.values(dict).map((value) => {
    visited++;
    if ((value as { id: string }).id === "b") throw new RangeError(`stopped at ${visited}`);
    return value;
  });
} catch (error) {
  console.log(error instanceof RangeError, (error as Error).message, visited);
}
try {
  Object.values(null as unknown as Dict).map((value) => value);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
