// The class-values fences: everything outside the honest v1 boundary is a
// NAMED fence — never wrong dispatch, never silently-wrong storage.
class Base {
  constructor(n: number) {}
  static tag = "base";
}
class Derived extends Base {
  // A DIFFERENT constructor ABI than Base's.
  constructor() {
    super(1);
  }
}
class Shadowing extends Base {
  static tag = "shadowed";
}
class Unrelated {
  constructor(n: number) {}
  static tag = "unrelated";
}

// Builtin classes with their own construction as values (Error and its
// standard subclasses are values; AggregateError is not).
const E = AggregateError;
const errorClasses = [E];

// Classes extending builtin bases as values (the error-message completion
// rule has no thunk ABI).
class MyErr extends Error {}
const M = MyErr;

// Structural class-value flows between unrelated classes: nominal identity
// is the IR's only class subtyping.
const structural: typeof Base = Unrelated;

// Widening whose constructor ABIs differ: construction through the slot
// would dispatch a mismatched signature.
const widened: typeof Base = Derived;

// Writing an inherited static through a SUBCLASS name creates an own
// property in JS — different storage.
class PlainSub extends Base {}
PlainSub.tag = "write";

// Writing statics through a general class VALUE: the runtime class decides.
let someClass: typeof Base = Base;
someClass.tag = "write";

// Reading a static a subclass REDECLARES through a class value: the
// runtime class decides which declaration answers.
console.log(someClass.tag);

// Local classes with statics still need per-evaluation static storage.
function make(): unknown {
  return class { static value = 1; };
}
make();

// Statics-bearing class expressions outside a whole-initializer position:
// their declaration-time code must run exactly where the expression
// evaluates.
const pair = [1, class WithStatic { static x = 1; }] as const;

// Construction through a UNION of class values: narrow or annotate first.
class Left {
  constructor() {}
}
class Right {
  constructor() {}
}
let pick: typeof Left | typeof Right = Left;
const picked = new pick();
void picked;

// A polymorphic class value cannot specialize a receiver-dependent method.
class UsesThis {
  static self(): string {
    return this.name;
  }
}
class OtherThis extends UsesThis {}
function self(value: typeof UsesThis): string { return value.self(); }
console.log(self(OtherThis));
