// Map.prototype.forEach with a callback that is not a function: Node's
// `<value> is not a function`, with the value's type prefix.
const map = new Map([["a", 1]]);
const reported = (value) => {
  try {
    map.forEach(value);
    return "no error";
  } catch (error) {
    return error.name + ": " + error.message;
  }
};
console.log(reported(0));
console.log(reported(-1.5));
console.log(reported({}));
console.log(reported([]));
console.log(reported(null));
console.log(reported(undefined));
console.log(reported("x"));
console.log(reported(Symbol("s")));
console.log(reported(true));
console.log(reported(10n));
console.log(reported(/re/));

// A callable callback visits (value, key, map) in insertion order.
const seen = [];
new Map([["a", 1], ["b", 2]]).forEach((value, key, visited) => {
  seen.push([key, value, visited.size]);
});
console.log(JSON.stringify(seen));

// forEach's thisArg reaches a non-arrow callback.
const box = { tag: "ctx" };
const rows = [];
map.forEach(function (value, key) {
  rows.push(this === box, key, value);
}, box);
console.log("thisArg", rows.join(","));

// The entries an iteration deletes are skipped and the ones it adds are
// visited, as Node's live map iteration does.
const mutated = new Map([["a", 1], ["b", 2]]);
const visited = [];
mutated.forEach((value, key) => {
  visited.push(key);
  if (key === "a") {
    mutated.delete("b");
    mutated.set("c", 3);
  }
});
console.log("mutated", visited.join(","));

// Map.prototype.forEach.call runs the same visit on its own receiver.
const called = [];
Map.prototype.forEach.call(new Map([["k", 9]]), (value, key) => {
  called.push(key, value);
});
console.log("prototype call", called.join(","));

// An untyped receiver's non-callable callback throws a TypeError too (the
// message comes from the checked-dynamic call, not this unit's checks).
const untyped = new Map([["a", 1]]);
console.log("untyped", reported2(untyped, 0));
function reported2(collection, value) {
  try {
    collection.forEach(value);
    return "no error";
  } catch (error) {
    return error.name;
  }
}
