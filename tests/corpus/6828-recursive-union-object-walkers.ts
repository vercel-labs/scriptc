// Recursive walkers over a JSON-like union: the array branch calls the
// walker for each element, and the record branch reads the narrowed record
// with Object.values, Object.keys and Object.entries.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function depth(value: Json): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depth));
  if (value !== null && typeof value === "object") return 1 + Math.max(0, ...Object.values(value).map(depth));
  return 0;
}

function count(value: Json): number {
  let total = 1;
  if (Array.isArray(value)) {
    for (const item of value) total += count(item);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) total += count(item);
  }
  return total;
}

function paths(value: Json, prefix: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => paths(item, `${prefix}[${index}]`));
  if (value !== null && typeof value === "object") {
    const out: string[] = [];
    for (const key of Object.keys(value)) out.push(...paths(value[key]!, `${prefix}.${key}`));
    for (const [key, item] of Object.entries(value)) if (item === null) out.push(`${prefix}.${key}=null`);
    return out;
  }
  return [`${prefix}=${String(value)}`];
}

const doc: Json = JSON.parse('{"a":[1,{"b":[true,null]}],"c":{"d":"x"},"e":[]}');
console.log(depth(doc), count(doc));
console.log(paths(doc, "$").join(" "));
console.log(depth(3), count([[[]]]), paths([], "$"));

// A computed-key read or write in a branch that an array hole reaches throws
// Node's TypeError after the key (and, for a write, the value) evaluates.
type Bag = number | string | number[] | { [key: string]: number };
const keys: string[] = [];
function keyOf(k: string): string {
  keys.push(k);
  return k;
}
function isBag(value: Bag): value is { [key: string]: number } {
  return !Array.isArray(value) && typeof value !== "string" && typeof value !== "number";
}
function bump(value: Bag, k: string): string {
  if (isBag(value)) {
    value[keyOf(k)] = (value[keyOf(k)] ?? 0) + 1;
    return String(value[keyOf(k)]);
  }
  return "-";
}
function put(value: Bag, k: string): string {
  if (isBag(value)) {
    value[keyOf(k)] = keys.length;
    return "put";
  }
  return "-";
}
function peek(value: Bag, k: string): string {
  if (isBag(value)) return typeof value[keyOf(k)];
  return "-";
}
const bags: Bag[] = [{ a: 1 }, "s", [1]];
bags.length = 4;
for (const which of ["bump", "put", "peek"]) {
  const out: string[] = [];
  for (let i = 0; i < bags.length; i++) {
    try {
      const k = "a" + which.length;
      if (which === "bump") out.push(bump(bags[i], k));
      else if (which === "put") out.push(put(bags[i], k));
      else out.push(peek(bags[i], k));
    } catch (e) {
      out.push(e instanceof TypeError ? e.message : "other");
    }
  }
  console.log(out.join(" | "));
}
console.log(keys.join(","), JSON.stringify(bags));
