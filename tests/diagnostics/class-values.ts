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

// Statics-bearing class expressions outside a whole-initializer position:
// their declaration-time code must run exactly where the expression
// evaluates.
const pair = [1, class WithStatic { static x = 1; }] as const;

// An ARM of a conditional evaluates only when it is selected: declaration-
// time code emitted at the enclosing statement would run on the other arm's
// path as well.
const arm = pair.length > 0 ? class Selected { static x = 1; } : class Other {};
void arm;

// A name read ahead of the class-building argument is not inert: the
// declaration-time code can assign the binding before the call reads it.
let seen = 0;
function consume(first: number, second: unknown) {
  return first + String(second);
}
console.log(consume(seen, class Writes { static { seen = 7; } }));

// The callee evaluates before every argument: a callee that runs code must
// run before the class-building argument's declaration-time code.
function pickConsumer(): (first: number, second: unknown) => string {
  console.log("callee first");
  return consume;
}
console.log(pickConsumer()(0, class Late { static x = (console.log("statics second"), 1); }));
class Plain {}
function Stamped(B: typeof Plain) {
  return class extends B { static stamp = (console.log("statics second"), 1); };
}
console.log(pickConsumer()(0, Stamped(Plain)));

// A callee member the class's declaration-time code can replace through a
// computed key or Object.assign, or one a getter can answer (the interface
// does not pin the value behind it), must be read before that code runs.
const slot: string = "define";
const table = {
  define(name: string, C: unknown): string { return name + String(C); },
};
console.log(table.define("swap", class Swap { static { (table as Record<string, unknown>)[slot] = () => "replaced"; } }));
const shelf = {
  define(name: string, C: unknown): string { return name + String(C); },
};
const replacement: { define(name: string, C: unknown): string } = { define: () => "replaced" };
console.log(shelf.define("assign", class Assign { static { Object.assign(shelf, replacement); } }));
interface Definer {
  define(name: string, C: unknown): string;
}
const viaGetter: Definer = {
  get define() { console.log("getter first"); return (name: string) => name; },
};
console.log(viaGetter.define("getter", class Got { static x = (console.log("statics second"), 1); }));

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
