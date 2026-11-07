// A derived constructor that returns a primitive throws a TypeError, and
// the spec (10.2.2 [[Construct]]) raises it where the construction returns,
// not at the `return` statement. So a `try` inside the constructor body
// cannot catch it, the body's `finally` blocks still run first, and the
// error reaches the `new` site as a real TypeError whose `constructor` is
// `TypeError`. A BASE constructor's primitive return is ignored instead:
// `new C()` answers the constructed `this`.
// @ts-nocheck -- a derived constructor's primitive return is TS2409 in typed
// TypeScript and legal JavaScript; the checker's JS diagnostics would
// otherwise refuse the whole program.
function describe(value) {
  if (value instanceof TypeError) return "TypeError:" + value.message;
  return "value:" + value;
}

class Base {
  constructor(tag) {
    this.tag = tag;
  }
}
class ReturnsNumber extends Base {
  constructor(tag) {
    super(tag);
    this.ranBody = true;
    return 42;
  }
}
class ReturnsString extends Base {
  constructor(tag) {
    super(tag);
    return "text";
  }
}
class ReturnsNull extends Base {
  constructor(tag) {
    super(tag);
    return null;
  }
}
class ReturnsBoolean extends Base {
  constructor(tag) {
    super(tag);
    return true;
  }
}
class ReturnsSymbol extends Base {
  constructor(tag) {
    super(tag);
    return Symbol("brand");
  }
}
class ReturnsUndefined extends Base {
  constructor(tag) {
    super(tag);
    return undefined;
  }
}

for (const C of [ReturnsNumber, ReturnsString, ReturnsNull, ReturnsBoolean, ReturnsSymbol]) {
  try {
    new C("primitive");
    console.log("constructed");
  } catch (error) {
    console.log(describe(error), error.constructor === TypeError, error.name);
  }
}

// The constructed instance survives an `undefined` return.
class UndefinedReturnsInstance extends Base {
  constructor(tag) {
    super(tag);
    return undefined;
  }
}
const keptA = new ReturnsUndefined("kept");
console.log(describe(keptA.tag), keptA instanceof ReturnsUndefined, keptA instanceof Base);
const keptB = new UndefinedReturnsInstance("kept");
console.log(describe(keptB.tag), keptB instanceof UndefinedReturnsInstance, keptB instanceof Base);

// A base constructor ignores the primitive: the constructed `this` answers.
class BaseReturnsNumber {
  constructor() {
    this.kept = true;
    return 7;
  }
}
const baseMade = new BaseReturnsNumber();
console.log(describe(baseMade.kept), baseMade instanceof BaseReturnsNumber);

// The body's own `catch` cannot observe the TypeError; its `finally` still
// runs before the construction throws.
var bodyCaught = 0;
class CatchesInside extends Base {
  constructor(tag) {
    super(tag);
    try {
      return 1;
    } catch (error) {
      bodyCaught++;
    }
  }
}
try {
  new CatchesInside("inside");
} catch (error) {
  console.log("outside-only", describe(error), bodyCaught);
}

var finallyRan = 0;
class RunsFinally extends Base {
  constructor(tag) {
    super(tag);
    try {
      return 3;
    } finally {
      finallyRan++;
    }
  }
}
try {
  new RunsFinally("finally");
} catch (error) {
  console.log("finally-first", describe(error), finallyRan);
}

// The returned operand is evaluated exactly once, after `super()`.
var evaluations = 0;
function operand() {
  evaluations++;
  return 9;
}
class EvaluatesOnce extends Base {
  constructor(tag) {
    super(tag);
    return operand();
  }
}
try {
  new EvaluatesOnce("once");
} catch (error) {
  console.log("evaluated", describe(error), evaluations);
}

// An untyped return decides at run time: a primitive throws and
// `undefined` keeps the instance. (A returned plain object is a separate
// refusal: it replaces the instance, which scriptc does not represent.)
function opaque(value) {
  return value;
}
class OpaqueReturn extends Base {
  constructor(tag, value) {
    super(tag);
    return opaque(value);
  }
}
for (const value of [5, "s", null, false, undefined]) {
  try {
    const made = new OpaqueReturn("opaque", value);
    console.log("opaque", describe(made), made instanceof OpaqueReturn);
  } catch (error) {
    console.log("opaque", describe(error));
  }
}

// A failed construction leaves nothing behind: later constructions of the
// same class still throw (and never miss) their own TypeError.
for (let i = 0; i < 3; i++) {
  try {
    new ReturnsNumber("again");
  } catch (error) {
    console.log("repeated", i, describe(error));
  }
}

// `super()` into a class whose constructor returns a primitive throws at
// the call, where the subclass's body can catch it.
class SubclassOfNumber extends ReturnsNumber {}
try {
  new SubclassOfNumber("chain");
} catch (error) {
  console.log("chain", describe(error));
}
var caughtSuper = "none";
class CatchesSuper extends ReturnsNumber {
  constructor(tag) {
    try {
      super(tag);
    } catch (error) {
      caughtSuper = describe(error);
    }
  }
}
try {
  new CatchesSuper("caught");
} catch (error) {
  console.log("chain-caught", caughtSuper, describe(error));
}
