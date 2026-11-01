'use strict';
// JavaScript's function `length` is the ExpectedArgumentCount: the
// parameters before the first one with an initializer or a rest element
// (ECMA-262 15.1.3), not the native parameter count.
function plain(a, b, c) {}
function firstDefault(a = 1, b) {}
function lastDefault(a, b = 2) {}
function middleDefault(a, b = 2, c) {}
function trailingComma(a, b = 1,) {}
function restOnly(...items) {}
function afterRest(a, ...items) {}
const arrowDefault = (x = 42) => {};
const arrowPlain = (x, y) => {};
const arrowRest = (x, ...r) => {};
function* genDefault(a, b = 1) {}
async function asyncDefault(a = 1) {}
async function* asyncGenDefault(a, b = 2) {}

const holder = {
  plain(a, b) {},
  withDefault(a = 1) {},
  shorthand(a, b = 5) {},
};
class Klass {
  method(a, b = 1) {}
  static staticMethod(a = 1) {}
}

function report(label, value) {
  const d = Object.getOwnPropertyDescriptor(value, 'length');
  console.log(label, value.length, d.value, d.writable, d.enumerable, d.configurable);
}
report('plain', plain);
report('firstDefault', firstDefault);
report('lastDefault', lastDefault);
report('middleDefault', middleDefault);
report('trailingComma', trailingComma);
report('restOnly', restOnly);
report('afterRest', afterRest);
report('arrowDefault', arrowDefault);
report('arrowPlain', arrowPlain);
report('arrowRest', arrowRest);
report('genDefault', genDefault);
report('asyncDefault', asyncDefault);
report('asyncGenDefault', asyncGenDefault);
report('objectPlain', holder.plain);
report('objectDefault', holder.withDefault);
report('objectShorthand', holder.shorthand);
report('method', Klass.prototype.method);
report('staticMethod', Klass.staticMethod);
console.log('protoLength', Klass.prototype.method.length, Klass.staticMethod.length);
