// A record converted from dynamic data keeps the source's own key order;
// a spread of it enumerates and serializes in that order, as Node's
// CopyDataProperties does. Differentially vs Node.
interface Pair {
  a: string;
  b: string;
}
const parsed = JSON.parse('{"b":"2","a":"1"}') as Pair;
console.log(Object.keys(parsed).join(","));
console.log(JSON.stringify(parsed));
const copy = { ...parsed };
console.log(Object.keys(copy).join(","));
console.log(JSON.stringify(copy));
console.log(JSON.stringify({ ...parsed, c: "3" }));
