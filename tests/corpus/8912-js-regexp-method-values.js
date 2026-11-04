// RegExp.prototype's methods read as values: exec, test and toString are one
// interned function each, so the prototype read, the regex-literal read and
// the read off a regex value are the same object, the reported name and
// length are the specification's, and Function.prototype's call/apply run
// them on the receiver they are given. exec requires the [[OriginalSource]]
// slot, test goes through RegExpExec (so a custom own exec is used), and
// toString is generic over Get(source)/Get(flags). A direct call keeps its own
// intrinsic lowering.

function report(label, fn) {
  try {
    console.log(label, "value=" + String(fn()));
  } catch (e) {
    console.log(label, e.name, e instanceof TypeError);
  }
}

const exec = RegExp.prototype.exec;
const test = RegExp.prototype.test;
const toString = RegExp.prototype.toString;

console.log("types", typeof exec, typeof test, typeof toString);
console.log("names", exec.name, test.name, toString.name);
console.log("lengths", exec.length, test.length, toString.length);
console.log("stable", exec === RegExp.prototype.exec, test === RegExp.prototype.test);
console.log("stable-toString", toString === RegExp.prototype.toString);
console.log("literal-values", /a/.exec === exec, /a/.test === test, /a/.toString === toString);
console.log("prototype-member", RegExp.prototype.exec.prototype, test.prototype === undefined);
console.log("own-name", exec.hasOwnProperty("name"), exec.propertyIsEnumerable("name"));

report("exec-basic", () => exec.call(/a/g, "zab"));
report("exec-twice", () => {
  const re = /a/g;
  return JSON.stringify([exec.call(re, "aa"), exec.call(re, "aa")]);
});
report("exec-miss", () => exec.call(/q/, "abc"));
report("test-hit", () => test.call(/b/, "abc"));
report("test-miss", () => test.call(/z/, "abc"));
report("test-apply", () => test.apply(/b/, ["abc"]));
report("toString-plain", () => toString.call(/a/));
report("toString-flags", () => toString.call(/a/gi));
report("toString-generic", () => toString.call({ source: "x", flags: "g" }));
report("toString-escaped", () => String(toString.call(/\n/g)));
report("custom-exec-hit", () => {
  const custom = { exec: (s) => (s === "hit" ? ["match"] : null) };
  return test.call(custom, "hit");
});
report("custom-exec-miss", () => {
  const custom = { exec: (s) => (s === "hit" ? ["match"] : null) };
  return test.call(custom, "miss");
});
report("custom-exec-bad", () => test.call({ exec: () => 1 }, "x"));

report("exec-object", () => exec.call({}, "x"));
report("exec-number", () => exec.call(7, "x"));
report("exec-null", () => exec.call(null, "x"));
report("exec-undefined", () => exec.call(undefined, "x"));
report("exec-no-this", () => exec("x"));
report("test-object", () => test.call({}, "x"));
report("test-no-this", () => test());
report("toString-number", () => toString.call(7));
report("toString-null", () => toString.call(null));
report("holder", () => {
  const holder = {};
  holder.test = test;
  return holder.test("x");
});

const directExec = /ab+/.exec("xabb");
console.log("direct", /ab+/.test("abb"), directExec !== null, directExec !== null && /z/.test("abb"));
