// A Set and a Map that hold a unit key, as a WeakMap key, a WeakMap value
// and WeakSet members.
const s = new Set<string | null>(["a", null]);
const m = new Map<string | undefined, number>([[undefined, 1], ["k", 2]]);


const notes = new WeakMap<Set<string | null>, string>();
notes.set(s, "the set");
console.log(notes.get(s), notes.has(s));

const tables = new WeakMap<object, Map<string | undefined, number>>();
const owner = { id: 1 };
tables.set(owner, m);
const table = tables.get(owner);
if (table !== undefined) {
  console.log(table.get(undefined), table.get("k"), table.has(undefined));
  for (const k of table.keys()) console.log(k === undefined ? "<undefined>" : k);
  console.log(table);
}

const members = new WeakSet<object>();
members.add(s);
members.add(m);
console.log(members.has(s), members.has(m));
