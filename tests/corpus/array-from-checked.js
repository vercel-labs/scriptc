function copy(value) { return Array.from(value); }
const item = { count: 7 };
const source = [item, "text", undefined];
function verify(source) {
  const result = copy(source);
  console.log(result !== source, result[0] === source[0], result.length);
  console.log(JSON.stringify(result));
}
verify(source);
console.log(JSON.stringify(copy("a😀b")));
console.log(JSON.stringify(copy(new Uint8Array([1, 255]))));
console.log(JSON.stringify(copy(42)), JSON.stringify(copy(true)), JSON.stringify(copy(1n)));
for (const value of [null, undefined]) {
  try { copy(value); } catch (error) { console.log(error.name, error.message); }
}

const prototype = {
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
};
const wrapped = Object.create(prototype);
wrapped.items = [3, 4, 5];
console.log(JSON.stringify(copy(wrapped)));
console.log(JSON.stringify(copy({ 0: "first", 2: "last", length: 3.7 })));
console.log(JSON.stringify(copy({ length: -2 })));
console.log(JSON.stringify(copy({ length: "2", 1: true })));

function live(value) {
  const iterator = value[Symbol.iterator]();
  const next = iterator.next;
  console.log(iterator[Symbol.iterator]() === iterator, next === iterator.next);
  console.log(JSON.stringify(next.call(iterator)));
  value.push(20);
  console.log(JSON.stringify(iterator.next()));
  console.log(JSON.stringify(iterator.next()));
  value.push(30);
  console.log(JSON.stringify(iterator.next()));
}
live([10]);

function identities(array, string, bytes) {
  const a = array[Symbol.iterator]();
  const s = string[Symbol.iterator]();
  const b = bytes[Symbol.iterator]();
  console.log(a.next === b.next, a.next === s.next);
  console.log(array[Symbol.iterator] === Array.prototype.values);
  for (const [next, receiver] of [[a.next, s], [s.next, a]]) {
    try { next.call(receiver); } catch (error) { console.log(error.name); }
  }
}
identities([], "", new Uint8Array());
const savedIterator = Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator] = function () {
  return { next() { return { done: true }; } };
};
console.log(JSON.stringify(copy([1, 2])));
Array.prototype[Symbol.iterator] = savedIterator;

let nextReads = 0;
let doneReads = 0;
let valueReads = 0;
const custom = {
  [Symbol.iterator]() {
    let index = 0;
    return {
      get next() {
        nextReads++;
        return function () {
          const current = index++;
          return {
            get done() { doneReads++; return current === 2; },
            get value() { valueReads++; return current; }
          };
        };
      }
    };
  }
};
console.log(JSON.stringify(copy(custom)), nextReads, doneReads, valueReads);
const failure = new Error("iterator failed");
function failing() {
  return { [Symbol.iterator]() { return { next() { throw failure; } }; } };
}
function same(left, right) { return left === right; }
try { copy(failing()); } catch (error) { console.log(same(error, failure)); }

class NativeCursor {
  index = 0;
  next() { return { done: this.index === 2, value: this.index++ }; }
}
const cursorPrototype = { [Symbol.iterator]() { return new NativeCursor(); } };
console.log(JSON.stringify(copy(Object.create(cursorPrototype))));
