/* A generator method VALUE crossing the checked-value boundary.
 *
 * A class whose methods are reachable through its prototype object answers
 * its methods as checked (dynamic) values: the value read off an instance is
 * the same function object the prototype carries, a checked callback can hold
 * it and call it, and the generator object it produces keeps the generator
 * protocol across the box. Node is the oracle. */
class Seq {
  constructor(tag) {
    this.tag = tag;
  }
  *items(n) {
    for (let i = 0; i < n; i++) yield this.tag + ":" + i;
    return n;
  }
  async *later(n) {
    yield n + 1;
    return n;
  }
}

function sameValue(actual, expected, label) {
  if (actual !== expected) throw new Error("not the same: " + label);
}
function typeofOf(value) {
  return typeof value;
}
function callWith(receiver, fn, ...args) {
  return fn.apply(receiver, args);
}

const seq = new Seq("a");
sameValue(seq.items, Seq.prototype.items, "instance method value");
sameValue(seq.items, seq.items, "repeated read");
sameValue(seq.later, Seq.prototype.later, "async instance method value");
console.log(typeofOf(seq.items), typeofOf(seq.later));

const gen = callWith(seq, seq.items, 2);
console.log(gen.next().value, gen.next().value);
const finished = gen.next();
console.log(finished.value, finished.done);

// The direct call answers its own generator object. (Identity and reflection
// on a generator object are separate, still-fenced operations.)
const direct = seq.items(1);
console.log(direct.next().value);

// An async generator value crosses the same boundary.
callWith(seq, seq.later, 4)
  .next()
  .then(function (step) {
    console.log("async", step.value, step.done);
  });
