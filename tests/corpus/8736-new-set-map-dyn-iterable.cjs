// `new Set(x)` and `new Map(x)` where x is a checked-dynamic value: the native
// collection seeds from the dynamic iterator, converting each element and each
// Map entry at the boundary. The seed is lazy (it stops and closes the source
// at the first bad entry), duplicates collapse in insertion order, the copy
// owns its storage, nullish sources make empty storage, and a non-iterable or
// a non-entry Map value throws Node's TypeError. Node runs this program
// byte-for-byte.
'use strict';

function pass(v) {
  return v;
}

const state = JSON.parse(
  '{"names":["a","b","a"],"counts":[3,1,3],"none":null,"text":"héllo","bad":42,"blank":{},' +
    '"table":[["k",5],["j",6],["k",7]],"objects":[["a",1],["a",2],{"0":"b","1":3},["c",4]],' +
    '"badEntry":["ab"],"mixedEntry":[["a",1],"xy",["b",2]]}',
);

// Insertion order and duplicate collapse, and the copy owns its storage.
const names = new Set(state.names);
console.log(names.size, [...names].join(','));
names.add('c');
names.delete('a');
console.log(names.size, [...names].join(','));
console.log(state.names.length, state.names.join(','));

// Element types and code-point iteration of a dynamic string.
console.log([...new Set(state.counts)].join(','));
console.log([...new Set(state.text)].join('|'));

// Nullish sources make empty storage; `??` picks the fallback only then.
console.log(new Set(state.none).size);
console.log([...new Set(state.none ?? ['f'])].join(','));
console.log([...new Set(state.names ?? ['f'])].join(','));

// A dynamic value may itself hold a native Set.
const native = new Set(['p', 'q', 'p']);
const nativeCopy = new Set(pass(native));
console.log([...nativeCopy].join(','), nativeCopy.size, native.size);
nativeCopy.add('r');
console.log(native.size, [...native].join(','));

// Non-iterable dynamic sources throw Node's TypeError.
try {
  new Set(state.bad);
} catch (error) {
  console.log(error.name + ':', error.message);
}
try {
  new Set(state.blank);
} catch (error) {
  console.log(error.name + ':', error.message);
}

// Map seeds: insertion order, last duplicate wins, copy independence.
const table = new Map(state.table);
console.log(table.size, [...table].map(([k, v]) => k + '=' + v).join(','));
table.set('z', 3);
console.log(table.size, state.table.length);

// Entries may be any 2-element array-like.
console.log([...new Map(state.objects)].map(([k, v]) => k + '=' + v).join(','));

// An empty dynamic source constructs empty storage.
console.log(new Map(state.none).size);
console.log(new Map(state.none ?? []).size);
const nativeTable = new Map([
  ['n', 1],
  ['m', 2],
]);
console.log([...new Map(pass(nativeTable))].map(([k, v]) => k + '=' + v).join(','));

// Non-iterables and malformed entries throw Node's TypeError.
try {
  new Map(state.bad);
} catch (error) {
  console.log(error.name + ':', error.message);
}
try {
  new Map(state.badEntry);
} catch (error) {
  console.log(error.name + ':', error.message);
}

// The seed is lazy: it stops and closes the source at the first bad entry.
let steps = 0;
let closes = 0;
const tracked = {
  [Symbol.iterator]() {
    return {
      next() {
        steps += 1;
        if (steps === 1) return { value: ['a', 1], done: false };
        if (steps === 2) return { value: 'xy', done: false };
        return { value: ['c', 3], done: false };
      },
      return() {
        closes += 1;
        return { done: true };
      },
    };
  },
};
try {
  new Map(tracked);
} catch (error) {
  console.log(error.message);
}
console.log(steps, closes);
