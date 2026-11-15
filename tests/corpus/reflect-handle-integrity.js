// Reflect.isExtensible and Reflect.preventExtensions over runtime handles:
// a program that adds its own property to a handle installs the handle
// property table, so the integrity query answers from it instead of
// refusing. The plain Object entries and the member values agree.
const date = new Date(0);
date.tag = "x";
console.log("date", Reflect.isExtensible(date));
console.log("date prevent", Reflect.preventExtensions(date), Reflect.isExtensible(date));
console.log("date again", Reflect.preventExtensions(date), Reflect.isExtensible(date));
const regexp = /a/;
regexp.tag = 1;
const isExtensible = Reflect.isExtensible;
console.log("regexp", isExtensible(regexp));
const map = new Map([["k", 1]]);
console.log(
  "map",
  Reflect.isExtensible(map),
  Reflect.preventExtensions(map),
  Reflect.isExtensible(map),
);
