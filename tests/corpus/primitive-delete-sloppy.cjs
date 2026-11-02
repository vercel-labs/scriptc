// A sloppy-mode module's `delete` on a primitive base: a String wrapper's
// indexes and `length` are non-configurable, so deleting one answers false
// instead of throwing (8702 covers the strict answer and the nullish base).
// The checker calls a String's index signature read-only and declines these
// deletes; the runtime answers them.
function report(fn) {
  try {
    return `ok ${String(fn())}`;
  } catch (error) {
    return `${error.constructor.name} ${error instanceof TypeError} ${error.message}`;
  }
}

const letters = "abc";
// @ts-ignore: JavaScript deletes a String index.
console.log(report(() => delete letters[0]));
// @ts-ignore: JavaScript deletes a String's `length`.
console.log(report(() => delete letters.length));
// @ts-ignore: JavaScript deletes a String index the value does not have.
console.log(report(() => delete letters[3]));
// @ts-ignore: JavaScript deletes a String index.
console.log(report(() => delete "abc"[1]));
console.log(report(() => delete (5)[0]));
console.log(report(() => delete (true).x));
console.log(report(() => delete (null).x));

// The statement form answers the same way, and its refusal is not an error.
// @ts-ignore: JavaScript deletes a String index.
delete letters[0];
// @ts-ignore: JavaScript deletes a String's `length`.
delete letters.length;
// @ts-ignore: JavaScript deletes a String index the value does not have.
delete letters[3];
console.log("statement delete ok");

// A Symbol key names no property of the wrapper, so the delete succeeds.
const symbolKey = Symbol.iterator;
// @ts-ignore: JavaScript deletes a String's Symbol key.
console.log(report(() => delete letters[symbolKey]));

// An optional delete on a nullish base short-circuits: true, and the key
// never evaluates.
const keyOrder = [];
function recordedKey() {
  keyOrder.push("key");
  return 0;
}
console.log(report(() => delete (void 0)?.[recordedKey()]));
console.log(keyOrder.length);
