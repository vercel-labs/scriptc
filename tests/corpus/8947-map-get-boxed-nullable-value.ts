// A map or set keyed by `string | null` keeps that union a tagged box in the
// whole program. A Map.get of such a value is a `string | null | undefined`,
// which stays a plain nullable pointer, so the read converts the stored box
// instead of handing it on as the pointer.
const keyed = new Map<string | null, number>();
keyed.set(null, 0);
keyed.set("k", 1);
console.log(keyed.get(null), keyed.get("k"), keyed.get("z"));
const seen = new Set<string | null>([null, "a"]);
console.log(seen.has(null), seen.has("b"));

const byName = new Map<string, string | null>([
  ["a", "A" + 1],
  ["n", null],
]);
const got = byName.get("a");
const gotNull = byName.get("n");
const gotMissing = byName.get("m");
console.log(got, gotNull, gotMissing, got ?? "u", gotNull ?? "u", gotMissing ?? "u");
console.log(byName.get("a") === "A1", byName.get("n") === null, byName.get("m") === undefined);
let total = 0;
for (let i = 0; i < 1000; i++) {
  const value = byName.get(i % 3 === 0 ? "a" : i % 3 === 1 ? "n" : "m");
  if (value === undefined) total += 1;
  else if (value === null) total += 10;
  else total += value.length * 100;
}
console.log(total);

const byNumber = new Map<number, string | null>([
  [1, "one" + ""],
  [2, null],
]);
console.log(byNumber.get(1), byNumber.get(2), byNumber.get(3));

function lookup(map: ReadonlyMap<string, string | null>, key: string): string | null | undefined {
  return map.get(key);
}
console.log(lookup(byName, "a"), lookup(byName, "n"), lookup(byName, "q"));
const nested = new Map<string, Map<string, string | null>>([["o", byName]]);
console.log(nested.get("o")?.get("a"), nested.get("o")?.get("n"), nested.get("p")?.get("a"));
const maybeMap: Map<string, string | null> | undefined = new Map([["k", "v" + 2]]);
console.log(maybeMap?.get("k"), maybeMap?.get("q"));
console.log(byName.get("n") ?? "fallback", byName.get("z") ?? "fallback", byName.get("a") ?? "-");
const weak = new WeakMap<object, string | null>();
const first = {};
const second = {};
weak.set(first, "w" + 1);
weak.set(second, null);
console.log(weak.get(first), weak.get(second), weak.get({}), weak.get(first) ?? "-");

// A memo of nullable answers, read back through `!== undefined`.
class Families {
  private readonly familyOf = new Map<string, string | null>();
  family(name: string, field: string): string | null {
    const key = `${name}\0${field}`;
    const cached = this.familyOf.get(key);
    if (cached !== undefined) return cached;
    const result = name === "A" ? null : `${name}.${field}`;
    this.familyOf.set(key, result);
    return result;
  }
}
const families = new Families();
const answers: string[] = [];
for (let round = 0; round < 3; round++)
  for (const name of ["A", "B", "C"]) answers.push(families.family(name, "x") ?? "-");
console.log(answers.join(" "));
