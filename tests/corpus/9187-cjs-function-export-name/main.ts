// A CommonJS module whose export is one function, read through an importer's
// binding: the function keeps the name its own definition gave it, whatever
// the importing binding is called. `module.exports = <anonymous definition>`
// names nothing (a member target is not a binding), so that function's name
// is empty.
import w from "./named.cjs";
import anon from "./anonymous.cjs";
import arrow from "./arrow.cjs";
import bound from "./bound.cjs";
import declared from "./declared.cjs";
import Klass from "./klass.cjs";
import NamedKlass from "./named-klass.cjs";
import { viaRequire } from "./via-require.cjs";

console.log(JSON.stringify([w.name, w.length, w("item", 2)]));
console.log(JSON.stringify([anon.name, anon.length, anon("item")]));
console.log(JSON.stringify([arrow.name, arrow.length, arrow("item", 1, 2)]));
console.log(JSON.stringify([bound.name, bound.length, bound("item")]));
console.log(JSON.stringify([declared.name, declared.length, declared("item")]));
console.log(JSON.stringify([Klass.name, new Klass("a").label]));
console.log(JSON.stringify([NamedKlass.name, new NamedKlass("b").label]));
console.log(JSON.stringify(viaRequire()));
