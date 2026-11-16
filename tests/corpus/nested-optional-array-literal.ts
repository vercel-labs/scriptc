// Nested arrays and spreads that carry an optional member's undefined: the
// element stays a present undefined inside an inner literal, across a
// spread that copies from an array typed property, and when spread into a
// wider literal.
interface Payload {
  label?: string;
  tags: string[];
  [key: string]: unknown;
}

const empty: Payload = { tags: ["t"] };
const full: Payload = { label: "l", tags: ["t", "u"] };

// A nested literal keeps the undefined in the inner array.
const nested = [[empty.label, "a"], [full.label, "b"]];
console.log(JSON.stringify(nested), nested.length, nested[0]!.length);

// Spreading an optional array property: an empty and a present source both
// copy their own elements into the literal, in order.
const emptySpread = [...empty.tags, empty.label];
console.log(JSON.stringify(emptySpread));
const fullSpread = [...full.tags, full.label];
console.log(JSON.stringify(fullSpread));

// A spread before and after the optional element keeps its index.
const before = [...full.tags, empty.label, "z"];
const after = ["y", empty.label, ...full.tags];
console.log(JSON.stringify(before), JSON.stringify(after));

// Spreading an array that already holds a present undefined copies it.
const source = [empty.label, "s"];
const copied = [...source, "e"];
console.log(JSON.stringify(source), JSON.stringify(copied), copied.length);

// A nested spread of a nested literal: the undefined survives each copy.
const deep = [[...source], [...[empty.label, full.label]]];
console.log(JSON.stringify(deep));
