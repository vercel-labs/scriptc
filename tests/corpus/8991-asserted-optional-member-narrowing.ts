// The asserted optional extension beside the reads and narrowings it must
// not disturb: a member the stored layout DECLARES keeps its own read on
// both sides of the assertion, the widened value is still the object the
// source produced (keys, JSON, identity, aliases), a union receiver keeps
// its arms, and a value that never went through a checked conversion has
// no source to answer from — the added member reads undefined, exactly
// Node's absent property.

interface Base {
  name: string;
  tags?: string[];
}

type Kind = { kind: "a"; aOnly: number } | { kind: "b"; bOnly: string };

const item = JSON.parse('{"name":"n","tags":["t"],"icons":["i"]}') as Base;

// A declared member reads the same through the assertion as without it.
const same = item as Base & { icons?: unknown };
console.log(
  "declared",
  same.name,
  JSON.stringify(same.tags ?? []),
  JSON.stringify((item as Base).tags ?? []),
);

// The widened value IS the source object: identity, keys and JSON agree
// with the unasserted read of the same value.
console.log(
  "object",
  String(same === item),
  Object.keys(same).join(","),
  JSON.stringify(same),
);

// A union receiver: each arm keeps its own member read.
function kindOf(value: Kind): string {
  const view = value as Kind & { icons?: unknown };
  return view.kind === "a" ? String(view.aOnly) : view.bOnly;
}
console.log("union", kindOf({ kind: "a", aOnly: 1 }), kindOf({ kind: "b", bOnly: "x" }));

// A value built by a literal, never converted: Node's absent member.
const fresh: Base & { icons?: unknown } = { name: "f" };
console.log("fresh", String(fresh.icons), JSON.stringify(fresh));

// Passing the widened value on keeps the layout and the source.
function nameOf(base: Base): string {
  return base.name;
}
console.log("pass", nameOf(same), Object.keys(same).join(","));
