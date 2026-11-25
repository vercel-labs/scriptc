// An unannotated `var` that every read sees stored, written in both arms of a
// feature test with a typed array and a plain array: the binding holds the
// union of those two storages, so element reads, element writes and `.length`
// dispatch on the storage the value holds rather than boxing it as a dynamic
// value. A reader that can run before the first store keeps the optional
// storage (the last case below).
'use strict';

function fillAndSum(typed) {
  var store;
  if (typed) {
    store = new Int32Array([1, 2, 3, 4]);
  } else {
    store = [1, 2, 3, 4];
  }

  /** @param {number} index @param {number} value */
  function put(index, value) {
    store[index] = value;
  }
  function sum() {
    var total = 0;
    for (var i = 0; i < store.length; i++) total += store[i];
    return total;
  }
  /** @param {number} index */
  function at(index) {
    return store[index];
  }
  function size() {
    return store.length;
  }

  put(1, 10);
  put(2, 20);
  return { sum: sum(), size: size(), first: at(0), last: at(3), past: at(4) };
}

console.log(JSON.stringify(fillAndSum(true)));
console.log(JSON.stringify(fillAndSum(false)));

// A `var` written the same way but also read while still unassigned: the
// unassigned state is observable, so it keeps its optional storage and the
// early read answers undefined.
function readBeforeStore() {
  var later;
  var before = later === undefined ? "unset" : "set";
  later = [7, 8];
  return before + ":" + later.length + ":" + later[1];
}
console.log(readBeforeStore());
