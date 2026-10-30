'use strict';
// Object.hasOwn over nullish receivers and as a value, and `delete` of
// properties JavaScript inference types as required.
const o = { a: 1, b: undefined };
console.log(Object.hasOwn(o, 'a'), Object.hasOwn(o, 'b'), Object.hasOwn(o, 'c'));
console.log(Object.hasOwn([1, 2], 1), Object.hasOwn([1, 2], 2), Object.hasOwn(Object.create({ x: 1 }), 'x'));
for (const value of [null, undefined]) {
  try {
    Object.hasOwn(value, 'a');
  } catch (e) {
    console.log(e.name, e.message);
  }
}
const pick = Math.random() < 2 ? { k: 1 } : null;
console.log(Object.hasOwn(pick, 'k'));
const hasOwn = Object.hasOwn;
console.log(hasOwn({ k: 1 }, 'k'), hasOwn({}, 'k'), [{ a: 1 }, {}].map((x) => hasOwn(x, 'a')).join());
const record = { a: 1, b: 2 };
delete record.a;
console.log(Object.keys(record).join(), Object.hasOwn(record, 'a'), record.a);
const table = { one: 1, two: 2 };
for (const key of Object.keys(table)) if (key === 'one') delete table[key];
console.log(JSON.stringify(table));
