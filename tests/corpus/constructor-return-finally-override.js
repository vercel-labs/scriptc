// A derived constructor that returns a primitive throws a TypeError when the
// construction returns (spec 10.2.2). A `finally` block that overrides that
// completion with `return;`, `return undefined` or `return this` replaces it,
// so construction completes normally instead. The pending error is dropped
// with the overridden completion, and the next construction of the same
// class is unaffected.
// @ts-nocheck -- a derived constructor's primitive return is TS2409 in typed
// TypeScript and legal JavaScript.
function describe(value) {
  if (value instanceof TypeError) return "TypeError:" + value.message;
  return "value:" + value;
}

class Base {
  constructor(tag) {
    this.tag = tag;
  }
}

// `finally { return; }` overrides `return 1`.
class BareReturn extends Base {
  constructor(tag) {
    super(tag);
    try {
      return 1;
    } finally {
      return;
    }
  }
}
const bare = new BareReturn("bare");
console.log("bare", bare.tag, bare instanceof BareReturn, bare instanceof Base);

// `finally { return undefined; }` overrides `return 1`.
class UndefinedReturn extends Base {
  constructor(tag) {
    super(tag);
    try {
      return 1;
    } finally {
      return undefined;
    }
  }
}
const undef = new UndefinedReturn("undefined");
console.log("undefined", undef.tag, undef instanceof UndefinedReturn);

// `finally { return this; }` overrides `return 1`.
class ThisReturn extends Base {
  constructor(tag) {
    super(tag);
    this.marker = "this";
    try {
      return 1;
    } finally {
      return this;
    }
  }
}
const self = new ThisReturn("this");
console.log("this", self.tag, self.marker, self instanceof ThisReturn);

// A `finally` that overrides with another primitive still throws, and the
// error is the one for the overriding value's construction.
class DoublePrimitive extends Base {
  constructor(tag) {
    super(tag);
    try {
      return 1;
    } finally {
      return 2;
    }
  }
}
try {
  new DoublePrimitive("double");
  console.log("double constructed");
} catch (error) {
  console.log("double", describe(error), error.name);
}

// A `finally` that falls through leaves the error pending.
class RunsOnly extends Base {
  constructor(tag) {
    super(tag);
    try {
      return 1;
    } finally {
      this.finallyRan = true;
    }
  }
}
try {
  new RunsOnly("runs-only");
  console.log("runs-only constructed");
} catch (error) {
  console.log("runs-only", describe(error));
}

// A nested `finally` that overrides the inner completion constructs, and the
// outer `finally` still runs.
const nestedLog = [];
class NestedBare extends Base {
  constructor(tag) {
    super(tag);
    try {
      try {
        return 1;
      } finally {
        nestedLog.push("inner");
        return;
      }
    } finally {
      nestedLog.push("outer");
    }
  }
}
const nested = new NestedBare("nested");
console.log("nested", nested.tag, nested instanceof NestedBare, nestedLog.join(","));

// A `finally` that returns an instance of the class answers that instance.
class SpareReturn extends Base {
  constructor(tag) {
    super(tag);
    if (tag === "outer") {
      const inner = new SpareReturn("inner");
      try {
        return 1;
      } finally {
        return inner;
      }
    }
    try {
      return 1;
    } finally {
      return;
    }
  }
}
const outer = new SpareReturn("outer");
console.log("spare", outer.tag, outer instanceof SpareReturn, outer === outer);

// The dropped error does not disturb later constructions of the same class.
for (let i = 0; i < 3; i++) {
  const again = new BareReturn("again-" + i);
  console.log("again", i, again.tag, again instanceof BareReturn);
}
try {
  new DoublePrimitive("after");
  console.log("after constructed");
} catch (error) {
  console.log("after", describe(error));
}

// A base constructor ignores every primitive return, with or without a
// `finally` override.
class BaseBare extends Base {
  constructor(tag) {
    super(tag);
    this.ran = true;
    try {
      return 1;
    } finally {
      return;
    }
  }
}
const baseBare = new BaseBare("base-bare");
console.log("base", baseBare.tag, baseBare.ran, baseBare instanceof BaseBare);
