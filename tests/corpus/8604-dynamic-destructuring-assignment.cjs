// Destructuring ASSIGNMENT over a checked-dynamic source: the object
// pattern reads one key per element, a default fires on the undefined read
// and is evaluated lazily, and `{ key: target = d }` spells the same thing.
var src = JSON.parse('[{"a":1},{"b":2},{}]');

// The for-of expression head arrives pre-lowered (no source text), so the
// pattern reads the element directly.
var seen = [];
for (var { a = "A", b = "B" } of src) seen.push(a + ":" + b);
console.log(seen.join(","));

// A pre-declared target head, with the shorthand default.
var x, y;
for ({ x = 10, y = 20 } of JSON.parse('[{"x":1},{}]')) console.log("head", x, y);

// Plain statement assignment, in both default spellings.
var t, k;
({ n: t = 9 } = JSON.parse('{}'));
console.log("renamed", t);
({ x = 5 } = JSON.parse('{}'));
console.log("shorthand", x);

// The default is lazy: it does not run when the key is present.
var hits = 0;
function bump() {
  hits = hits + 1;
  return "D";
}
({ k = bump() } = JSON.parse('{"k":"K"}'));
console.log("lazy-present", hits);
({ k = bump() } = JSON.parse('{}'));
console.log("lazy-missing", hits, k);

// A key that is not a plain identifier reads the live property, and the
// read order is source order.
var log = [];
var probe = {
  get p() {
    log.push("p");
    return 1;
  },
  get q() {
    log.push("q");
    return undefined;
  },
};
var p, q;
({ p, q = 2 } = probe);
console.log("order", log.join(","), p, q);

// Null and undefined sources keep JS's own TypeError, and the pattern's
// own assignment happens only after the read.
function name(f) {
  try {
    f();
    return "no throw";
  } catch (e) {
    return e instanceof TypeError ? "TypeError" : "other";
  }
}
var nul = JSON.parse("null");
console.log(name(function () {
  var z;
  ({ z } = nul);
}));
console.log(name(function () {
  var z;
  ({ z = 1 } = nul);
}));
console.log("done");
