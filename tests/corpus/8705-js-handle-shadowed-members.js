"use strict";
// Own properties that shadow a class member of a runtime handle: the write
// or definition is granted per class and name, explicit reads, calls and
// deletes see the own property, and deleting it restores the native member.
function callVia(o, k) { return o[k](); }
function getVia(o, k) { return o[k]; }

const d = new Date(0);
Object.defineProperty(d, "toString", {
  value: function () { return "own:" + this.getTime(); },
  configurable: true,
});
console.log("call", d.toString(), callVia(d, "toString"));
d.getTime = function () { return 42; };
console.log("getTime", d.getTime(), callVia(d, "getTime"), d.valueOf());
delete d.getTime;
console.log("restored", d.getTime(), getVia(d, "tag"));

const m = new Map([[1, "one"]]);
m.get = function (key) { return "patched " + key; };
console.log("map", m.get(1), m.has(1), m.size);
delete m.get;
console.log("map restored", m.get(1));

const r = /a/g;
r.test = function () { return "own test"; };
console.log("regexp", r.test("a"), r.source, String(r));
delete r.test;
console.log("regexp restored", r.test("a"), r.lastIndex);

const s = new Set([1]);
s.has = function () { return "own has"; };
console.log("set", s.has(1), s.size);
delete s.has;
console.log("set restored", s.has(1));
