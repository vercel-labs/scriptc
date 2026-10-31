"use strict";
// Computed-key reads of the members a plain object inherits from
// Object.prototype answer those members, as constant-key reads do: a key
// held in a variable, built at run time, or taken from parsed data.

const members = ["constructor", "toString", "valueOf", "hasOwnProperty", "propertyIsEnumerable"];
const plain = { a: 1 };
const parsed = JSON.parse('{"b":2,"keys":["constructor","valueOf","nope"]}');

for (const key of members) {
  const value = plain[key];
  console.log(key, typeof value, value === plain.constructor || value === plain.toString || value === plain.valueOf || value === plain.hasOwnProperty || value === plain.propertyIsEnumerable);
}
console.log(plain["constr" + "uctor"] === Object, parsed["construct" + "or"] === Object);
for (const key of parsed.keys) console.log("parsed", key, typeof parsed[key]);
/** @param {any} object @param {any} key */
const read = (object, key) => object[key];
console.log(read(plain, "constructor") === Object, typeof read(parsed, "toString"), read(plain, "missing"), read(plain, "a"));
console.log(plain["toString"].call({ x: 1 }), plain["hasOwnProperty"].call(plain, "a"), plain["valueOf"]() === plain);

// An own property of the same name wins, and a null-prototype object has none.
const shadow = { constructor: "own", toString: () => "mine" };
const bare = Object.create(null);
for (const key of members) console.log("shadow", key, typeof shadow[key], "bare", typeof bare[key]);
console.log(shadow["toString"](), String(shadow));

// Lookups that branch on an inherited member, as option parsers do.
/** @param {Record<string, unknown>} options @param {string} name */
function has(options, name) {
  return typeof options[name] === "function" ? "inherited-fn" : options[name] === undefined ? "absent" : "set";
}
console.log(["verbose", "toString", "constructor", "a"].map((name) => has({ verbose: true, a: 0 }, name)).join(","));
