// Computed-key reads on Set and Map instances: `s[name]` reads the property
// the key names — `size`, or a property the collection does not carry — not
// a collection entry. The read is checked-dynamic because the checker's
// Set/Map type describes no index signature; a method value read this way
// keeps its SC2020 fence.

const set = new Set([1, 2, 3]);
const map = new Map([["a", 1]]);

function read(target, key) {
  return target[key];
}

console.log(set["size"], read(set, "size"), read(map, "size"));
console.log(read(set, "missing"), read(map, "nope"), set[0], read(set, "0"));
const key = "size";
console.log(set[key], map[key]);
console.log(String(read(set, "size")), Number(map["size"]));

const fetched = [];
for (const name of ["size", "size", "missing"]) fetched.push(String(read(set, name)));
console.log(fetched.join(","));

// A Set built at run time and read through a key computed from a join.
const buildSet = (values) => new Set(values);
const numbers = buildSet([4, 5]);
console.log(numbers["size"], read(numbers, "size") + 1);

// The entry itself is not reachable through an index: a Set has no "0"
// property even when 0 is a member.
console.log(new Set([0])["0"], new Set([0]).has(0));

// A missing receiver still throws Node's TypeError naming the key.
function readOfMissing(target, name) {
  return target[name];
}
try {
  readOfMissing(undefined, "size");
  console.log("no throw");
} catch (e) {
  console.log("caught", e.name, e.message);
}

// The call form keeps working alongside the computed key.
console.log(set.has(2), map.get("a"));
