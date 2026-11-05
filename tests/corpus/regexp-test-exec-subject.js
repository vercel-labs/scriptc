// RegExp.prototype.test (22.2.6.3) with a custom exec and with a receiver
// expression. The subject is ToString'ed once, before RegExpExec, and exec
// receives exactly that one string. An exec result that is neither null nor
// an object, undefined included, is the TypeError Node reports. Reading the
// method value off a call evaluates the call first, so its side effects and
// throws happen before the member is read.

function report(label, fn) {
  try {
    console.log(label, "value=" + String(fn()));
  } catch (e) {
    console.log(label, e.name, e.message);
  }
}

const test = RegExp.prototype.test;

report("undefined-result", () => test.call({ exec: () => undefined }, "a"));
report("number-result", () => test.call({ exec: () => 3 }, "a"));
report("null-result", () => test.call({ exec: () => null }, "a"));

// The subject reaches exec as one ToString'ed string, not as the raw
// arguments test received.
report("coerced-subject", () =>
  test.call(
    {
      exec: function (subject) {
        console.log("  exec-args", arguments.length, typeof subject, String(subject));
        return null;
      },
    },
    45,
    "extra",
  ),
);
report("missing-subject", () =>
  test.call({
    exec: function (subject) {
      console.log("  exec-args", arguments.length, typeof subject, String(subject));
      return null;
    },
  }),
);
report("symbol-subject", () => test.call({ exec: () => null }, Symbol("s")));
report("object-subject", () => {
  let coerced = 0;
  const subject = {
    toString() {
      coerced++;
      return "hit";
    },
  };
  const matched = test.call({ exec: (s) => (s === "hit" ? ["m"] : null) }, subject);
  return matched + " " + coerced;
});

let reads = 0;
function makeRegExp() {
  reads++;
  return /a/;
}
const value = makeRegExp().test;
console.log("receiver-evaluated", reads, typeof value, value === test);

let failed = 0;
function makeOrFail() {
  failed++;
  if (failed === 1) throw new RangeError("receiver failed");
  return /a/;
}
report("receiver-throws", () => makeOrFail().test);
console.log("receiver-throws-count", failed);
report("receiver-throws-again", () => makeOrFail().test.call(/a/, "a"));
console.log("receiver-reads-count", reads);

const direct = /ab+/.test("xabb");
console.log("direct", direct);
