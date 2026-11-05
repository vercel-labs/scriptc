// `''.match(re) ?? []`: the empty array-literal default of a `??` adopts the
// left's present array arm. tsc gives the literal the uninhabited `never[]`
// element, which the compiler maps through never's f64 value representation
// (`number[]`), so the whole expression used to be `RegExpMatchArray |
// number[]` — a result no single array slot can receive.

// A union return (`"all" | readonly string[]`) whose array arm is the
// `?? []` result.
function reach(code: unknown): "all" | readonly string[] {
  if (typeof code !== "string") return [];
  return /\bALL\b/.test(code) ? "all" : (code.match(/\w+/g) ?? []);
}
console.log(JSON.stringify(reach(7)));
console.log(JSON.stringify(reach("ALL")));
console.log(JSON.stringify(reach("a.b c")));
console.log(JSON.stringify(reach("")));

// The default's element type is the left's: string element reads and a
// map callback over the value compile as strings, and an absent match
// answers the empty array Node does.
const names = "a-b c".match(/[a-z]+/g) ?? [];
console.log(names.map((name) => name.toUpperCase()).join("+"));
const none = "123".match(/[a-z]+/g) ?? [];
console.log(none.length, JSON.stringify(none), names.length);

// A declared optional array keeps its own type through the same default,
// and the fresh empty array is a value of its own (mutation, identity).
function fill(source: number[] | undefined, with_: number): number[] {
  const list = source ?? [];
  list.push(with_);
  return list;
}
console.log(JSON.stringify(fill(undefined, 1)), JSON.stringify(fill([7, 8], 9)));
const first = fill(undefined, 2);
const second = fill(undefined, 3);
console.log(first !== second, JSON.stringify(first), JSON.stringify(second));

// A parenthesized default and one inside a longer expression.
const longest = ("abbbc".match(/b+/g) ?? []).length;
console.log(longest, `${JSON.stringify("xyz".match(/q/g) ?? [])}!`);
