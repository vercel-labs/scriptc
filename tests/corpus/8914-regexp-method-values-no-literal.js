// RegExp.prototype's methods as values in a program that never compiles a
// regex literal. The unit that answers them is gated on the member read, so
// this program's runtime pack links it without scr_regex.c: the brand check
// must be the slot test the unit makes for itself, not a predicate that
// lives in the unit a program without a regex never links.

const exec = RegExp.prototype.exec;
const test = RegExp.prototype.test;
const toString = RegExp.prototype.toString;

function report(label, fn) {
  try {
    console.log(label, "value=" + String(fn()));
  } catch (e) {
    console.log(label, e.name, e instanceof TypeError);
  }
}

console.log("types", typeof exec, typeof test, typeof toString);
console.log("names", exec.name, test.name, toString.name);
console.log("lengths", exec.length, test.length, toString.length);
console.log("stable", exec === RegExp.prototype.exec, test === RegExp.prototype.test);

report("exec-object", () => exec.call({}, "x"));
report("exec-number", () => exec.call(7, "x"));
report("exec-null", () => exec.call(null, "x"));
report("exec-no-this", () => exec("x"));
report("test-object", () => test.call({}, "x"));
report("test-number", () => test.call(1, "x"));
report("test-no-this", () => test());
report("toString-number", () => toString.call(7));
report("toString-null", () => toString.call(null));
report("toString-generic", () => toString.call({ source: "x", flags: "g" }));
report("test-custom-exec-hit", () => {
  const custom = { exec: (s) => (s === "hit" ? ["match"] : null) };
  return test.call(custom, "hit");
});
report("test-custom-exec-bad", () => test.call({ exec: () => 1 }, "x"));
