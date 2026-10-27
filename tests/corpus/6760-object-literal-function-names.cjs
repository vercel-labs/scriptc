'use strict';
// A function stored in an object literal's property keeps the name Node
// gives it: a function read by name keeps that name, and an anonymous
// function, arrow or method takes the property's key.
function f() {}
const g = function () {};
const h = () => 1;
const named = function inner() {};
const o = {
  f,
  g,
  h,
  k: f,
  anon: function () {},
  arrow: () => 2,
  'a-b': () => 3,
  ['computed']: () => 4,
  m() {},
  named,
  inline: function own() {},
};
for (const key of Object.keys(o)) console.log(key, JSON.stringify(o[key].name));
console.log(o);
const mixed = { n: 1, s: 'x', f, g: function () {} };
console.log(mixed, mixed.g.name);
function show(value) {
  console.log(value);
}
show({ f, m() {} });
