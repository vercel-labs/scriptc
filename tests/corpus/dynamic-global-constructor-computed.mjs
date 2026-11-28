// A constructor name the program computes at run time: the global object
// read cannot be answered by a literal, so the dynConstructorAny fact keeps
// every dynamic constructor family installed.
const prefix = "Da";
const name = prefix + "te";
const date = new (globalThis[name])(0);
console.log("date " + date.toISOString() + " " + date.getTime());
const pick = ["Ma", "p"].join("");
const map = new (globalThis[pick])([["k", 5]]);
console.log("map " + map.get("k") + " " + map.size);
