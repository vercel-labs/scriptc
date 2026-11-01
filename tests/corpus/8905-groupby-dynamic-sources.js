// Object.groupBy and Map.groupBy through untyped sources and key functions:
// a JavaScript source passes the array and the callback as checked-dynamic
// values, so the grouping runs on the dynamic tier. Object.groupBy spells
// each key as a property name on a null-prototype object; Map.groupBy keeps
// the key values themselves with SameValueZero, and both results are live
// collections.

function groupByObject(items, keyOf) {
  return Object.groupBy(items, keyOf);
}

function groupByMap(items, keyOf) {
  return Map.groupBy(items, keyOf);
}

console.log(Object.keys(groupByObject([1, 2, 3, 4, 5], (n) => n % 2)).join(","));
console.log(groupByObject([1, 2, 3], (n) => n % 2)["0"].join(","));
console.log(JSON.stringify(groupByObject([1.5, -0, NaN], (n) => n)));
console.log(Object.keys(groupByObject([], (n) => n)).length);
console.log(Object.keys(groupByObject([1, 2, 3], (n, i) => i)).join(","));
console.log(groupByObject(["a", "bb", "cc"], (s) => s.length)["2"].join(","));

const byParity = groupByMap([1, 2, 3, 4, 5], (n) => n % 2);
console.log(byParity.size);
console.log(byParity.get(1).join(","), byParity.get(0).join(","));
console.log(byParity.has(2), byParity.get(2));
const nanKeys = groupByMap([1, 2, 3], (n) => (n === 2 ? NaN : 0));
console.log(nanKeys.size, nanKeys.get(NaN).join(","), nanKeys.get(0).join(","));
const zeroKeys = groupByMap([1, 2], (n) => (n === 1 ? -0 : 0));
console.log(zeroKeys.size);
const named = {};
const byReference = groupByMap([1, 2], (n) => (n === 1 ? named : {}));
console.log(byReference.size, byReference.get(named).length);
const noGroups = groupByMap([], (n) => n);
console.log(noGroups.size);

const pairs = [];
for (const [key, values] of byParity) pairs.push(key + "=" + values.join("/"));
console.log(pairs.join(" "));

// The mapping function runs once per element, in order, before the result
// exists; a throw from it propagates to the caller.
const seen = [];
groupByMap([7, 8, 9], (n) => {
  seen.push(n);
  return n;
});
console.log(seen.join(","));
try {
  groupByObject([1, 2], (n) => {
    if (n === 2) throw new Error("key failed");
    return n;
  });
  console.log("no throw");
} catch (e) {
  console.log("caught", e.message);
}
