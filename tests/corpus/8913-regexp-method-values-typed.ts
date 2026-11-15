// RegExp.prototype's methods as values in a typed source: reading
// RegExp.prototype.exec no longer refuses, the value is the same interned
// function a JavaScript source sees (and the one /a/g.exec reads), its
// call/apply forms compile, and the brand check answers the TypeError Node
// throws for a receiver that is not a RegExp. A direct call keeps its
// intrinsic lowering.

const exec: (this: unknown, s: string) => RegExpExecArray | null = RegExp.prototype.exec;
const test: (this: unknown, s: string) => boolean = RegExp.prototype.test;
const toString: (this: unknown) => string = RegExp.prototype.toString;

function report(label: string, fn: () => boolean): void {
  try {
    console.log(label, fn());
  } catch (e) {
    console.log(label, (e as Error).name);
  }
}

const fromLiteral: unknown = /a/g.exec;

console.log("types", typeof exec, typeof test, typeof toString);
console.log("stable", exec === RegExp.prototype.exec, test === RegExp.prototype.test);
console.log("literal", fromLiteral === exec);
report("exec-hit", () => exec.call(/a/g, "zab") !== null);
report("exec-miss", () => exec.call(/q/, "abc") === null);
report("test-hit", () => test.call(/b/, "abc"));
report("test-miss", () => test.call(/z/, "abc"));
report("exec-undefined", () => exec.call(undefined, "x") !== null);
report("test-number", () => test.call(1, "x"));
console.log("toString-plain", toString.call(/a/));
console.log("toString-flags", toString.call(/a/gi));
const directExec = /ab+/.exec("xabb");
console.log("direct", /ab+/.test("abb"), directExec !== null);

// A receiver that is a call is evaluated before the member is read, and a
// receiver that throws stops the read.
let reads = 0;
function makeRegExp(): RegExp {
  reads++;
  return /a/;
}
const fromCall: unknown = makeRegExp().test;
console.log("receiver-evaluated", reads, fromCall === test);
function makeOrFail(): RegExp {
  reads++;
  if (reads === 2) throw new RangeError("receiver failed");
  return /a/;
}
report("receiver-throws", () => (makeOrFail() as RegExp).test === test);
console.log("receiver-reads", reads);
