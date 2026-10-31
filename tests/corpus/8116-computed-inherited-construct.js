"use strict";
// Constructing through a builtin constructor that a computed or constant key
// reads off a value, in a program that calls no method on an untyped value:
// `new (o[key])()` builds what `new Object()`, `new Map()` and `new Date()`
// build.

const plain = { a: 1 };
const key = ["constr", "uctor"].join("");
const ObjectCtor = plain[key];
const kept = JSON.parse('{"z":1}');
console.log(typeof ObjectCtor, JSON.stringify(new ObjectCtor()), new ObjectCtor(kept) === kept);
console.log(typeof plain[key + "s"], plain.constructor === ObjectCtor);

// Collections and dates held as untyped values, as JavaScript holds them.
const held = JSON.parse("{}");
held.map = new Map([[1, "one"], [2, "two"]]);
held.day = new Date(0);
held.set = new Set(["x"]);
const map = held.map;
const MapCtor = map[key];
const copy = new MapCtor(map);
console.log(typeof MapCtor, copy.size, map.constructor === MapCtor, copy.constructor === MapCtor);

const day = held.day;
const DateCtor = day[key];
console.log(JSON.stringify(new DateCtor(86400000)), day.constructor === DateCtor);

const set = held.set;
const SetCtor = set[key];
console.log(new SetCtor(["a", "b", "a"]).size);
