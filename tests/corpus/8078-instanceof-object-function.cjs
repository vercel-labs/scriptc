'use strict';
// `x instanceof Object` and `x instanceof Function` on untyped values follow
// Node: objects are instances of Object unless their prototype chain ends
// in null first, and functions (classes and arrows included) are instances
// of Function.
class Shape {}
class Square extends Shape {}

const nullProto = Object.create(null);
const underNull = Object.create(nullProto);
const regrown = Object.create(null);
Object.setPrototypeOf(regrown, {});
const orphan = function orphan() {};
Object.setPrototypeOf(orphan, null);
function declared() {}

const values = {
  'plain object': {},
  array: [1, 2],
  'Object.create(null)': nullProto,
  'object under a null-prototype object': underNull,
  'Object.create(null) given a prototype': regrown,
  'Object.create(plain object)': Object.create({ a: 1 }),
  'parsed JSON': JSON.parse('{"a":[1]}'),
  'function declaration': declared,
  'bound function': declared.bind(null),
  'arrow function': () => 1,
  'async function': async () => {},
  class: Square,
  'class instance': new Square(),
  'function with a null prototype': orphan,
  map: new Map(),
  date: new Date(0),
  'regular expression': /x/,
  error: new TypeError('t'),
  'typed array': new Uint8Array(2),
  promise: Promise.resolve(1),
  number: 1,
  string: 's',
  boolean: false,
  null: null,
  undefined: undefined,
  symbol: Symbol('s'),
  bigint: 10n,
};

for (const [label, value] of Object.entries(values)) {
  console.log(`${label}: Object ${value instanceof Object}, Function ${value instanceof Function}`);
}

function describe(value) {
  if (!(value instanceof Object)) return 'primitive or null-prototype';
  return value instanceof Function ? 'function' : 'object';
}
console.log([nullProto, {}, describe, 0].map(describe).join(', '));
