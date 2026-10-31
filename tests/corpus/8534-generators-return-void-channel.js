// A generator whose body never returns a value is typed with a valueless
// return channel, but ECMAScript completes it with whatever `.return(v)`
// supplies: the runtime parks the value in the type-erased RET slot and
// promotes it to OUT when the unwind finishes. `.return()` with no
// argument still answers undefined, and the completed, unstarted,
// suspended-at-yield and finally-draining states all deliver the value.
function* g() {
  yield 0;
  yield 1;
}

var iter = g();
var first = iter.next();
console.log("suspended", first.done === false, first.value);
var completed = iter.return(45);
console.log("suspended.return", completed.done === true, completed.value);

// A completed generator still answers the supplied value.
var done = g();
done.next();
done.next();
done.next();
var afterDone = done.return(33);
console.log("completed.return", afterDone.done === true, afterDone.value);

// The body never runs, and the value still delivers.
var ran = false;
function* unstarted() {
  ran = true;
  yield 1;
}
var fresh = unstarted();
var early = fresh.return("early");
console.log("unstarted.return", early.done === true, early.value, ran);

// A finally runs before the completion; the parked value survives it.
var log = [];
function* withFinally() {
  try {
    yield 1;
  } finally {
    log.push("fin");
  }
}
var guarded = withFinally();
guarded.next();
var unwound = guarded.return("survives");
console.log("finally.return", unwound.done === true, unwound.value, log.join(","));

// A finally that returns a value of its own replaces the parked one; this
// channel IS valued, so the plain path is unchanged.
function* replacing() {
  try {
    yield 1;
  } finally {
    return "replacement";
  }
}
var replaced = replacing();
replaced.next();
var replacement = replaced.return("ignored");
console.log("finally.replaces", replacement.done === true, replacement.value);

// `.return()` with no argument answers undefined.
var bare = g();
var bareResult = bare.return();
console.log("bare.return", bareResult.done === true, bareResult.value === undefined);

// Objects and numbers cross into the widened value slot unchanged.
var boxed = g();
boxed.next();
var objectResult = boxed.return({ tag: "object" });
console.log("object.return", objectResult.done === true, objectResult.value.tag);

var counted = g();
counted.next();
var numberResult = counted.return(2.5);
console.log("number.return", numberResult.done === true, numberResult.value);

// A generator that yields values still re-yields before the return.
function* numbers() {
  for (var i = 0; i < 3; i++) yield i;
}
var counting = numbers();
console.log("step", counting.next().value, counting.next().value);
var stopped = counting.return(99);
console.log("counted.return", stopped.done === true, stopped.value);

// The static receiver form: the call goes through the typed lowering.
var typed = g();
console.log("typed", typed.return(7).value);

// An untyped receiver reaches the checked-dynamic dispatch.
function resumeWith(gen, value) {
  gen.next();
  return gen.return(value);
}
var dispatched = resumeWith(g(), "dispatched");
console.log("dispatched.return", dispatched.done === true, dispatched.value);
