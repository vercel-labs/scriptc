// A dynamic value crossing into a native record type that is recursive
// through a checked slot: a node's method answers the next node, so the
// checked domain re-enters the same record. The static check answers that
// back-edge coinductively and validates every reachable field, so the
// extraction compiles and the value behaves as in Node — including a Map
// field beside the recursion.

interface Entry {
  label: string;
  counts: Map<string, number>;
  next(): Entry | undefined;
}

function build(label: string): Entry {
  return {
    label,
    counts: new Map([["hits", label.length]]),
    next() {
      return label.length > 1 ? build(label.slice(1)) : undefined;
    },
  };
}

function coerce(value: any): Entry {
  return value;
}

function walk(entry: Entry | undefined): string {
  const parts: string[] = [];
  let cursor = entry;
  while (cursor !== undefined) {
    parts.push(`${cursor.label}:${cursor.counts.get("hits")}`);
    cursor = cursor.next();
  }
  return parts.join(">");
}

const root = build("abcd");
const dynamic: unknown = root;
const entry = coerce(dynamic);
console.log(entry.label, entry.counts.get("hits"));
console.log(walk(entry));
console.log(walk(entry.next()?.next()));

// The extracted value keeps the Map semantics: a mutation is visible through
// the extracted record and a new key inserts.
entry.counts.set("extra", 1);
entry.counts.set("hits", entry.counts.get("hits")! + 1);
console.log(entry.counts.size, entry.counts.get("hits"), entry.counts.has("extra"));
console.log([...entry.counts.keys()].join(","));
