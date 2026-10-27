function make(name, params) {
  const Parent = (params && params.Parent) || Object;
  class Definition extends Parent {
    describe() {
      return `${name}:${this.kind}`;
    }
  }
  return Definition;
}
const A = make("A");
const a = new A();
a.kind = "plain";
console.log(typeof a, a instanceof A, a.describe(), JSON.stringify(a), Object.keys(a));
const E = make("E", { Parent: Error });
const e = new E("boom");
e.kind = "error";
console.log(e instanceof E, e.message, typeof e.stack, e.describe(), Object.keys(e), String(e));
const Parent = E;
console.log(e instanceof Parent, new E() .message === "", Object.prototype.hasOwnProperty.call(new E(), "message"));
try {
  throw new E("thrown");
} catch (err) {
  console.log(err instanceof E, err.message);
}
console.log(e instanceof Error, new A() instanceof Error);
try {
  throw new E("caught");
} catch (err) {
  console.log(err instanceof Error, err.message);
}
// The cause option is read like Error's: inherited and accessor causes
// count, and a throwing getter's exception propagates.
const inherited = new E("inherited", Object.create({ cause: "from prototype" }));
console.log(inherited.cause, Object.prototype.hasOwnProperty.call(inherited, "cause"));
let reads = 0;
const accessor = new E("accessor", {
  get cause() {
    reads++;
    return "from getter";
  },
});
console.log(accessor.cause, reads, "cause" in new E("none", {}), "cause" in new E("undef", { cause: undefined }));
try {
  new E("throws", {
    get cause() {
      throw new Error("getter failed");
    },
  });
} catch (err) {
  console.log(err.message);
}
