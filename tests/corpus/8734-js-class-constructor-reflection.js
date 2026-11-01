"use strict";
// A class value reflected as an object (t262-da A2): its own-key table holds
// length, name, prototype and every declared static with Node's attributes.
class C {
  static *m() { return 42; }
  static get g() { return 1; }
  static f = 7;
  #x;
  static s() {}
  constructor(a, b) {}
}
const d = (k) => JSON.stringify(Object.getOwnPropertyDescriptor(C, k), (key, v) => (typeof v === "function" ? "function" : v));
console.log(Object.getOwnPropertyNames(C).join(","));
for (const k of ["length", "name", "prototype", "m", "g", "f", "s"]) console.log(k, d(k));
C.f = 8;
console.log(d("f"), Object.prototype.hasOwnProperty.call(C, "#x"), C.hasOwnProperty("m"));
var E = class { static a() {} };
console.log(Object.getOwnPropertyNames(E).join(","), Object.prototype.hasOwnProperty.call(E, "a"));
const arrow = () => 1;
function plain() {}
console.log(Object.prototype.hasOwnProperty.call(arrow, "caller"), Object.prototype.hasOwnProperty.call(plain, "prototype"));
