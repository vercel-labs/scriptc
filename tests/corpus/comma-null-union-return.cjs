// `return log(), null` from a function that otherwise returns a list: the
// comma expression's effects run, then null takes the result's
// representation.
"use strict";
async function promote(list) {
  if (list.length === 0) return console.log("no static mounts"), null;
  return list.map((x) => x * 2);
}
function first(list) {
  if (list.length === 0) return console.log("empty"), undefined;
  return list[0];
}
promote([]).then((v) => console.log("promoted", v));
promote([1, 2]).then((v) => console.log("promoted", v));
console.log(first([]), first([7]));
