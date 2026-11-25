// An unannotated `var` that every read sees stored and whose plain writes
// all store arrays or typed arrays, but that some other write can make hold
// something else: a destructuring assignment, a `for`-`in` or `for`-`of`
// head, or an element write or `push`/`unshift`/`splice`/`fill` call that
// stores an element its arrays cannot hold. Each keeps the dynamic storage
// that performs every one of those writes. So does a binding written with
// both an array and a typed array that code uses through a method, another
// property, a string key or a `for`-`in` loop, which only one storage
// answers.
'use strict';

function destructured(flag) {
  var list;
  list = [1, 2];
  if (flag) [list] = ["text"];
  return typeof list === "string" ? list.length : list[0];
}
console.log(destructured(false), destructured(true));

function objectDestructured(source) {
  var view;
  view = new Int32Array(2);
  ({ view } = source);
  return view.length;
}
console.log(objectDestructured({ view: "hello" }));

function defaulted(xs) {
  var cell;
  cell = [1];
  [cell = [2, 3]] = xs;
  return cell.length;
}
console.log(defaulted(["four"]), defaulted([]));

function iterated(rows, keys) {
  var item;
  item = [0];
  for (item of rows) {}
  var seen = typeof item + ":" + item.length;
  var key;
  key = [1, 2, 3];
  for (key in keys) {}
  return seen + " " + typeof key + ":" + key.length;
}
console.log(iterated(["abc", "de"], { name: 1 }));

function elementWrites() {
  var numbers;
  numbers = [1, 2, 3];
  numbers[0] = "x";
  var pushed;
  pushed = [1, 2];
  pushed.push("three");
  pushed.unshift(true);
  var spliced;
  spliced = [1, 2, 3];
  spliced.splice(1, 1, "mid");
  spliced.fill(null, 2);
  var appended;
  appended = [1, 2];
  appended[0] += "s";
  return JSON.stringify([numbers, pushed, spliced, appended]);
}
console.log(elementWrites());

function methodUses(typed) {
  var store;
  if (typed) store = new Int32Array([1, 2, 3, 4]);
  else store = [1, 2, 3, 4];
  var total = 0;
  store.forEach((value) => {
    total += value;
  });
  for (var key in store) total += store[key];
  return [store.join("-"), store.indexOf(3), store.slice(2).length, store["1"], total].join(" ");
}
console.log(methodUses(true), methodUses(false));

// A compound or increment store into an element is left to the dynamic
// storage too.
function numericUpdates(typed) {
  var store;
  if (typed) store = new Int32Array(3);
  else store = [1, 2, 3];
  store[0]++;
  store[1] += 4;
  store[2] ^= 6;
  return Array.from(store).join(",");
}
console.log(numericUpdates(true), numericUpdates(false));

// Writes of what the binding already holds keep its static storage: numbers
// stored into the union's elements, and numbers a plain array gains through
// its storing methods.
function sameElements(typed) {
  var store;
  if (typed) store = new Int32Array(4);
  else store = [1, 2, 3, 4];
  store[1] = 9;
  store[3] = store[1] + store.length;
  return Array.from(store).join(",") + " " + store.length;
}
console.log(sameElements(true), sameElements(false));

function grows() {
  var list;
  list = [1, 2];
  list.push(3, 4);
  list.unshift(0);
  list.splice(1, 0, 0.5);
  list.fill(7, 6);
  return list.join(",");
}
console.log(grows());
