// Array destructuring of a Map or Set walks its iterator: Map entries as
// [key, value] pairs, Set values, holes and rest included.
const m = new Map([["a", "1"], ["b", "2"], ["c", "3"]]);
const [[name, value], ...rest] = m;
console.log(name, value, rest.length, JSON.stringify(rest));
const [first, , third] = m;
console.log(JSON.stringify(first), JSON.stringify(third));
const s = new Set([3, 1, 2]);
const [x, y, ...others] = s;
console.log(x, y, others);
let [p] = new Map<string, number>([["only", 1]]);
p = ["changed", 2];
console.log(p);
function firstKey(map: Map<string, number>): string {
  const [[k]] = map;
  return k;
}
console.log(firstKey(new Map([["z", 26]])));
