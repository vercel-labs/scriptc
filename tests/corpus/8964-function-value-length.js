'use strict';
// A function value's `length` is the function's own ExpectedArgumentCount
// (ECMA-262 15.1.3), so a value that can be any of several functions reads
// the one it holds at runtime — never a static guess from one declaration.
function two(a, b) {
  return a + b;
}
function oneDefault(a, b = 1) {
  return a + b;
}
function rest(...xs) {
  return xs.length;
}
function none() {
  return 0;
}
const flag = false;

// Direct declarations and const aliases keep their own count.
console.log('direct', two.length, oneDefault.length, rest.length, none.length);
const alias = two;
const aliasOfAlias = alias;
console.log('alias', alias.length, aliasOfAlias.length);

// A conditional over functions of DIFFERENT arities: the value's own
// declaration decides, in both arm orders.
const boundTwo = true ? two : oneDefault;
const boundDefault = false ? two : oneDefault;
const boundRest = false ? oneDefault : rest;
console.log('bound', boundTwo.length, boundDefault.length, boundRest.length);
console.log('direct1', (flag ? two : oneDefault).length, (flag ? oneDefault : two).length);

// Value flow: through a parameter, through a call result, through `let`.
const read = (fn) => fn.length;
console.log('param', read(two), read(oneDefault), read(rest), read(none));
const pick = (c) => (c ? two : rest);
console.log('result', pick(true).length, pick(false).length);
let held = two;
held = rest;
console.log('held', held.length);

// A lifted closure records its own count only where it has no declaration
// to name at the box (captures included).
const capture = (k) => (flag ? (a) => k : (a, b) => k + b);
console.log('capture', capture(1).length, capture(1)(5, 6));

// Methods and storing the value in a record member.
const holder = { m1(a) {}, m2(a, b) {} };
const method = flag ? holder.m1 : holder.m2;
console.log('method', method.length, holder.m1.length, holder.m2.length);
const member = { fn: flag ? oneDefault : two };
console.log('member', member.fn.length);

// The descriptor path answers the same length.
const described = Object.getOwnPropertyDescriptor(flag ? two : rest, 'length');
console.log('descriptor', described.value);

// Builtin function values keep Node's counts.
console.log('builtin', Math.max.length, Math.min.length);
