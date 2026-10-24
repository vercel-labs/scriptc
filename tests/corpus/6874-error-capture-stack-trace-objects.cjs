// Error.captureStackTrace on objects in JavaScript, as Node does it: an own,
// non-enumerable, configurable `stack` accessor giving the object's heading
// (its name and message when first read, through Error.prototype.toString's
// rules, "Error" by default) and the frames from the caller; TypeErrors for a
// primitive and a non-extensible target.
'use strict';
function frames(stack) {
  const lines = String(stack).split('\n');
  const names = lines.slice(1).map((line) => line.trim().split(' ')[1]);
  return `${lines[0]} | ${names.filter((name) => ['inner', 'middle', 'outer', 'skipped', 'caller'].includes(name)).join(',')}`;
}
function inner(target) {
  Error.captureStackTrace(target);
  return target;
}
function middle(target) {
  return inner(target);
}
function outer(target) {
  return middle(target);
}
console.log('plain', frames(outer({}).stack));
console.log('named', frames(outer({ name: 'Parse', message: 'bad token' }).stack));
console.log('message only', frames(outer({ message: 'just this' }).stack));
console.log('empty name', frames(outer({ name: '', message: 'no name' }).stack));
console.log('number fields', frames(outer({ name: 7, message: 8 }).stack));
const own = inner({ kept: 1 });
console.log('keys', JSON.stringify(Object.keys(own)), typeof own.stack);
const descriptor = Object.getOwnPropertyDescriptor(own, 'stack');
console.log('descriptor', typeof descriptor.get, typeof descriptor.set, descriptor.enumerable, descriptor.configurable);
own.stack = 'replaced';
console.log('writable', own.stack);
const later = inner({ message: 'first' });
later.name = 'Renamed';
later.message = 'second';
console.log('formatted when read', frames(later.stack));
later.name = 'Again';
console.log('formatted once', frames(later.stack));
const counted = { message: 'm' };
let reads = 0;
Object.defineProperty(counted, 'name', { get() { reads++; return 'Counted'; } });
inner(counted);
console.log('reads before stack', reads);
console.log('counted', frames(counted.stack), reads);
function skipped(target) {
  Error.captureStackTrace(target, skipped);
  return target;
}
function caller(target) {
  return skipped(target);
}
console.log('constructorOpt', frames(caller({}).stack));
const arr = [];
Error.captureStackTrace(arr);
console.log('array', frames(arr.stack), arr.length);
for (const value of [5, 'text', undefined, null, true]) {
  try {
    Error.captureStackTrace(value);
    console.log('primitive', String(value), 'no error');
  } catch (error) {
    console.log('primitive', String(value), error.name, error.message);
  }
}
try {
  Error.captureStackTrace(Object.freeze({}));
  console.log('frozen', 'no error');
} catch (error) {
  console.log('frozen', error.name, error.message);
}
const api = {
  run(target) {
    Error.captureStackTrace(target, api.run);
    return target;
  },
};
function viaApi(target) {
  return api.run(target);
}
console.log('member constructorOpt', frames(viaApi({ message: 'member' }).stack).split(' | ')[0]);
const captureFn = Error.captureStackTrace;
function viaValue(target) {
  captureFn(target);
  return target;
}
const fromValue = viaValue({ message: 'value' });
fromValue.message = 'read later';
console.log('function value', frames(fromValue.stack), captureFn.name, captureFn.length);
try {
  captureFn(7);
} catch (error) {
  console.log('function value primitive', error.name, error.message);
}
