// Buffer.concat's checks run in Node's order: the list is an Array, an empty
// list answers an empty Buffer, then the total validates (ERR_INVALID_ARG_TYPE
// for a non-number, ERR_OUT_OF_RANGE for a bad one), and only then do the
// list's elements. An empty list therefore ignores even a null total, a bad
// list is reported as the list even beside a bad total, and a bad total on a
// non-empty list is reported before any element.
import { Buffer } from "node:buffer";

function shape(fn) {
  try {
    const out = fn();
    return "ok " + out.length + " " + JSON.stringify(out.toString("latin1"));
  } catch (e) {
    return e.name + " " + String(e.code) + " " + e.message;
  }
}

const none = [];
const one = [Buffer.alloc(1, 0x61)];
const mixed = [Buffer.alloc(1, 0x61), 2];

// An empty list answers an empty Buffer whatever the total is.
console.log(shape(() => Buffer.concat(none)));
console.log(shape(() => Buffer.concat(none, null)));
console.log(shape(() => Buffer.concat(none, -1)));
console.log(shape(() => Buffer.concat(none, JSON.parse('"x"'))));
console.log(shape(() => Buffer.concat(none, 9007199254740992)));

// The total's value: a sum, an explicit undefined, and a longer or shorter
// length than the parts.
console.log(shape(() => Buffer.concat(one)));
console.log(shape(() => Buffer.concat(one, undefined)));
console.log(shape(() => Buffer.concat(one, 4)));
console.log(shape(() => Buffer.concat(one, 0)));

// A total that is not a number, and one that is out of range.
console.log(shape(() => Buffer.concat(one, null)));
console.log(shape(() => Buffer.concat(one, JSON.parse('"x"'))));
console.log(shape(() => Buffer.concat(one, 1.5)));
console.log(shape(() => Buffer.concat(one, -1)));
console.log(shape(() => Buffer.concat(one, NaN)));
console.log(shape(() => Buffer.concat(one, Infinity)));

// A list that is not an Array, with a valid total and with a bad one.
console.log(shape(() => Buffer.concat("x", 1)));
console.log(shape(() => Buffer.concat("x", null)));

// A non-empty list reports its total before its elements, and its elements
// in order when the total is valid.
console.log(shape(() => Buffer.concat(mixed)));
console.log(shape(() => Buffer.concat(mixed, 100)));
console.log(shape(() => Buffer.concat(mixed, null)));
console.log(shape(() => Buffer.concat(mixed, -1)));

// The one-argument and two-argument forms agree on valid input.
console.log(Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]).toString());
console.log(Buffer.concat([Buffer.from("ab"), Buffer.from("cd")], 5).toString("latin1"));
