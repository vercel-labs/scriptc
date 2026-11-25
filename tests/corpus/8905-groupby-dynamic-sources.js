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

// The source is walked by its own iterator while the callbacks run, as
// Node's ArrayGroupBy walks it: entries an untyped source gains during the
// call are grouped and entries it loses are skipped.
function groupLiveArray(items) {
  return Object.groupBy(items, (n) => {
    if (n === 1) items.push(3);
    return n % 2;
  });
}
const growable = [1, 2];
const grown = groupLiveArray(growable);
console.log(grown["1"].join(","), grown["0"].join(","), growable.join(","));

function groupLiveSet(values) {
  return Object.groupBy(values, (n) => {
    if (n === 1) values.add(3);
    if (n === 2) values.delete(3);
    return n % 2;
  });
}
const growingSet = new Set([1, 2]);
const grownSet = groupLiveSet(growingSet);
console.log(grownSet["1"].join(","), grownSet["0"].join(","), [...growingSet].join(","));

function groupLiveMap(entries) {
  return Map.groupBy(entries, (entry) => {
    if (entry[0] === "a") entries.set("c", 3);
    return entry[1];
  });
}
const growingMap = new Map([
  ["a", 1],
  ["b", 2],
]);
const grownMap = groupLiveMap(growingMap);
console.log(
  grownMap.get(1).join(","),
  grownMap.get(2).join(","),
  grownMap.get(3).join(","),
  growingMap.size,
);

// A throwing callback closes the source's iterator where the throw
// happened: the generator is not drained first, and its finally block runs
// before the throw reaches the caller.
function* traced(values) {
  try {
    for (const value of values) {
      console.log("yield", value);
      yield value;
    }
  } finally {
    console.log("closed");
  }
}
function groupUntilTwo(items) {
  return Object.groupBy(items, (n) => {
    if (n === 2) throw new Error("stop");
    return n;
  });
}
try {
  groupUntilTwo(traced([1, 2, 3]));
  console.log("no throw");
} catch (e) {
  console.log("caught", e.message);
}
