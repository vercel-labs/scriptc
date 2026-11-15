// JavaScript's [[Set]]/[[Get]] on a value whose static type does not
// declare the property: the added property lives with the object, survives
// every later view of it, and reads back (and enumerates) as Node's does.
var slice = ["easy"];
slice.index = 0;
slice.input = "easy";
console.log(slice.index, slice.input, slice.length, slice[0]);

/** @type {number[]} */
var numbers = [3, 1, 4];
numbers.tag = "ok";
numbers[3] = 5;
console.log(numbers.tag, numbers.length, numbers[1], Object.keys(numbers).join(","));
console.log(JSON.stringify(numbers), numbers.hasOwnProperty("0"));

/** @type {{count: number}} */
var record = { count: 1 };
record.note = "added";
record.count = record.count + 1;
console.log(record.count, record.note, Object.keys(record).join(","), JSON.stringify(record));

// The added property keeps JavaScript identity across the checked-dynamic
// boundary: a write through one untyped view is visible through another.
function tagIt(target) {
  target.fromHelper = "yes";
  return target.index === 0;
}
console.log(tagIt(slice), slice.fromHelper);

// A member the prototype supplies is not an own property, so it does not
// appear in the object's own keys.
var shaped = [7];
console.log(typeof shaped.constructor, Object.keys(shaped).join(","));

// Reading a member the object lacks answers undefined, as Node does.
console.log(numbers.missing === undefined, record.missing === undefined);
