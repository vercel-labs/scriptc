// Collection method values taken off an instance, and their receiver brand
// checks. JavaScript sources hold `s.add` as the runtime's interned
// Set.prototype.add, so a call through Function.prototype.call checks the
// receiver exactly as Node does.

function report(label, fn) {
  try {
    const value = fn();
    console.log(label + ": ok " + String(value));
  } catch (e) {
    const object = typeof e === "object" && e !== null;
    console.log(
      label +
        ": " +
        (object ? e.name : typeof e) +
        " instanceofTypeError=" +
        String(e instanceof TypeError) +
        " ctorIsTypeError=" +
        String(object && e.constructor === TypeError),
    );
  }
}

const s = new Set([1, 2]);
report("set-add-bad-object", function () {
  return s.add.call({}, 3);
});
report("set-add-bad-false", function () {
  return s.add.call(false, 3);
});
report("set-has-bad-null", function () {
  return s.has.call(null, 1);
});
report("set-delete-bad-string", function () {
  return s.delete.call("nope", 1);
});
report("set-add-good", function () {
  return s.add.call(s, 3);
});
console.log("set size " + s.size);

const m = new Map([["a", 1]]);
report("map-get-bad-object", function () {
  return m.get.call({}, "a");
});
report("map-set-bad-number", function () {
  return m.set.call(7, "b", 2);
});
report("map-has-bad-array", function () {
  return m.has.call([], "a");
});
report("map-get-good", function () {
  return m.get.call(m, "a");
});
report("map-set-good", function () {
  return m.set.call(m, "b", 2);
});
console.log("map size " + m.size);

const unbound = s.add;
console.log("typeof s.add " + typeof unbound);
report("unbound-call", function () {
  return unbound(4);
});
console.log("set size after unbound " + s.size);

// A receiver expression still runs for its effects.
let reads = 0;
function pick() {
  reads++;
  return s;
}
report("receiver-effects", function () {
  return pick().has.call({}, 1);
});
console.log("reads " + reads);

// A method read through a receiver that is missing (an out-of-bounds element
// of a `Set[]`): the member access on undefined throws Node's TypeError
// before the method value exists, rather than answering the builtin function.
const sets = [s];
const maps = [m];
report("set-method-missing-receiver", function () {
  return typeof sets[1].has;
});
report("map-method-missing-receiver", function () {
  return typeof maps[4].get;
});
console.log("present receivers " + typeof sets[0].has + " " + typeof maps[0].get);
