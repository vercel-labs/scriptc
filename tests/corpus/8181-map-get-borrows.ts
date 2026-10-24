// Map.get results held in locals across the operations that can and cannot
// release the entry's value: an update on the absent branch, a write, delete
// or clear before a later read, a call that may change the map, loops,
// string keys, and values that are stored, returned or compared.
class Counter {
  num: number;
  label: string;
  constructor(num: number, label: string) {
    this.num = num;
    this.label = label;
  }
}

function count(keys: number[]): Map<number, Counter> {
  const counts = new Map<number, Counter>();
  for (const key of keys) {
    const cur = counts.get(key);
    if (cur === undefined) counts.set(key, new Counter(1, `k${key}`));
    else cur.num++;
  }
  return counts;
}

function report(counts: Map<number, Counter>): string {
  const parts: string[] = [];
  for (const [key, value] of counts) parts.push(`${key}:${value.num}:${value.label}`);
  return parts.join(" ");
}

console.log("count", report(count([3, 1, 3, 2, 3, 1, 9])));

// A write replaces the entry's value while the old one is still read.
function replaceThenRead(m: Map<number, Counter>): string {
  const old = m.get(1);
  m.set(1, new Counter(100, "new"));
  return old === undefined ? "none" : `${old.num}:${old.label}`;
}
const replaced = new Map<number, Counter>([[1, new Counter(5, "old")]]);
console.log("replace", replaceThenRead(replaced), replaced.get(1)!.label);

// Deleting and clearing release the value before the read.
function deleteThenRead(m: Map<number, Counter>): string {
  const held = m.get(2);
  m.delete(2);
  return held === undefined ? "none" : held.label;
}
function clearThenRead(m: Map<number, Counter>): string {
  const held = m.get(2);
  m.clear();
  return held === undefined ? "none" : `${held.label}:${m.size}`;
}
console.log("delete", deleteThenRead(new Map([[2, new Counter(1, "two")]])));
console.log("clear", clearThenRead(new Map([[2, new Counter(1, "two")]])));

// A call that may change the map runs between the read and the use.
let shared = new Map<number, Counter>([[7, new Counter(7, "seven")]]);
function mutate(): void {
  shared.set(7, new Counter(70, "seventy"));
  shared = new Map();
}
function callBetween(): string {
  const held = shared.get(7);
  mutate();
  return held === undefined ? "none" : `${held.num}:${held.label}`;
}
console.log("call", callBetween());

// Reads on both branches, a write on one of them, and a read after the join.
function branches(m: Map<number, Counter>, k: number, write: boolean): string {
  const held = m.get(k);
  if (held === undefined) return "absent";
  if (write) m.set(k, new Counter(0, "zero"));
  else held.num += 10;
  return `${held.num}:${held.label}`;
}
const branchMap = new Map([[4, new Counter(4, "four")]]);
console.log("branches", branches(branchMap, 4, false), branches(branchMap, 4, true), branches(branchMap, 5, true));

// The value escapes into an array and a returned object.
function escape(m: Map<number, Counter>): Counter[] {
  const kept: Counter[] = [];
  for (let k = 0; k < 4; k++) {
    const value = m.get(k % 2);
    if (value !== undefined) kept.push(value);
  }
  m.clear();
  return kept;
}
const escapes = escape(new Map([[0, new Counter(0, "zero")], [1, new Counter(1, "one")]]));
console.log("escape", escapes.map((c) => c.label).join(","));
function returned(m: Map<number, Counter>): Counter | undefined {
  const value = m.get(3);
  return value;
}
const returnMap = new Map([[3, new Counter(3, "three")]]);
const got = returned(returnMap);
returnMap.clear();
console.log("returned", got?.label);

// String keys, including keys built at run time.
function words(text: string): string {
  const seen = new Map<string, Counter>();
  for (const word of text.split(" ")) {
    const entry = seen.get(word);
    if (entry === undefined) seen.set(word, new Counter(1, word.toUpperCase()));
    else entry.num++;
  }
  const parts: string[] = [];
  for (const [word, entry] of seen) parts.push(`${word}=${entry.num}/${entry.label}`);
  return parts.join(" ");
}
console.log("words", words("a b a c b a"));
const prefix = "k";
const byName = new Map<string, Counter>([["k1", new Counter(1, "one")]]);
const named = byName.get(prefix + "1");
byName.set("k1", new Counter(2, "two"));
console.log("named", named?.label, byName.get("k1")?.label);

// A loop whose body writes the map after the read on every pass.
function loopWrites(m: Map<number, Counter>): number {
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const value = m.get(i % 2);
    if (value !== undefined) total += value.num;
    m.set(i % 2, new Counter(i, "loop"));
    if (value !== undefined) total += value.num * 100;
  }
  return total;
}
console.log("loop", loopWrites(new Map([[0, new Counter(1, "a")], [1, new Counter(2, "b")]])));
