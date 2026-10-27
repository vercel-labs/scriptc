// TypeScript subclasses of Error may redeclare `cause` as `unknown` or
// `object`. The declaration defines the error's own enumerable `cause` after
// super() returns, exactly as Node does: without an initializer it replaces a
// cause passed through the options with undefined. `declare` and `abstract`
// declarations are erased and define nothing.
class Base extends Error {
  cause?: unknown;
  constructor(message?: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
const viaOptions = new Base("a", { cause: 1 });
console.log("cause" in viaOptions, viaOptions.cause, Object.keys(viaOptions));
console.log(Object.getOwnPropertyDescriptor(viaOptions, "cause"));
class Init extends Error {
  override cause: unknown = "init";
}
const init = new Init("b", { cause: "options" });
console.log(init.cause, Object.getOwnPropertyDescriptor(init, "cause"));
class Declared extends Error {
  declare cause: unknown;
}
const d1 = new Declared("c");
const d2 = new Declared("c", { cause: "kept" });
console.log("cause" in d1, d1.cause, "cause" in d2, d2.cause);
abstract class Abstract extends Error {
  abstract override cause: unknown;
}
class Concrete extends Abstract {
  override cause: object | null = null;
}
console.log(new Concrete("d").cause);
class Assign extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
const a = new Assign("e", new Error("inner"));
const inner = a.cause;
if (inner instanceof Error) console.log(inner.message);
delete a.cause;
console.log("cause" in a, a.cause);
class Sub extends Assign {
  override cause: unknown = "sub";
}
const s = new Sub("f", "x");
console.log("cause" in s, s.cause);
try {
  throw new Base("thrown", { cause: { code: 7 } });
} catch (e) {
  if (e instanceof Base) console.log(e.message, e.cause);
}
class OpenFeatureStyle extends Error {
  cause?: unknown;
  constructor(message?: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "OpenFeatureStyle";
    this.cause = options?.cause;
  }
}
const o = new OpenFeatureStyle("flag", { cause: "network" });
console.log(o.name, o.message, o.cause, o instanceof OpenFeatureStyle, o instanceof Error);
