// Inheritance edges the compiler rejects (tsc-clean, outside the subset).
class Animal {
  name: string = "a";
  speak(): string {
    return this.name;
  }
  feed(other: Animal): string {
    return other.name;
  }
}

// Abstract properties resolve through the concrete instance. Keep this
// accepted method beside the rejected inheritance forms to ensure their
// diagnostics do not reintroduce a refusal for abstract property reads.
abstract class Base {
  abstract kind(): string;
  abstract limit: number;
  usesLimit(): number {
    return this.limit;
  }
}
class Impl extends Base {
  limit = 5;
  kind(): string {
    return "i";
  }
}

// abstract GENERIC methods have no body to monomorphize
abstract class GenericAbstract {
  abstract pick<T>(x: T): T;
}

// extends must name a class the frontend can pin exactly: const aliases
// holding one class compile now (classes are values), but a REASSIGNABLE
// binding could hold any class at evaluation — the base stays a fence.
let AnimalAlias = Animal;
class Aliased extends AnimalAlias {}

// redeclaring an inherited field: the slot-type-exact WITH-initializer form
// lowers (corpus 2428); the BARE form (type stripping leaves `name;`, which
// Node [[Define]]s back to undefined) and the type-changing form keep fences
class BareRepeat extends Animal {
  // @ts-expect-error — tsc flags the overwrite (TS2612); the fence names Node's undefined reset
  name!: string;
}
class RetypedRepeat extends Animal {
  // @ts-expect-error — tsc rejects the incompatible redeclare too; the fence names the reason
  name: number = 2;
}

// an override must fit the inherited slot: a narrower parameter is checked
// at the slot and a shorter parameter list drops the rest there, but a
// shorter list whose body reads `arguments` has no adapter
class Shorter extends Animal {
  feed(): string {
    return this.name + arguments.length;
  }
}

// An override may add TRAILING optional or defaulted parameters (corpus
// 8540): the inherited slot keeps the base arity and fills the omitted
// values. A call that supplies one of the extras still needs the override's
// own body, which a virtual slot cannot carry — a subclass below makes this
// receiver virtual, so the surplus argument fences instead of vanishing.
class TrailingOption extends Animal {
  feed(other: Animal, note: string = "n"): string {
    return other.name + note;
  }
}
class TrailingOptionChild extends TrailingOption {
  feed(other: Animal, note: string = "c"): string {
    return other.name + note;
  }
}
const trailingOption: TrailingOption = new TrailingOption();
trailingOption.feed(new Animal(), "x");

// Conditional super() is supported; both branches initialize the receiver.
class Conditional extends Animal {
  constructor(flag: boolean) {
    if (flag) {
      super();
    } else {
      super();
    }
  }
}

// A record cannot be an instance of this native class and answers false.
const rec = { name: "r" };
console.log(rec instanceof Animal);

// ...and folds statically for standalone classes, which still evaluates
// both operands (Node evaluates them) before answering
class Point {
  x: number = 0;
}
console.log(new Point() instanceof Point);

// Reached: unreached bodies never lower, so their rejections only exist
// when something on the entry path uses them.
new Conditional(true);

// Reached: collection defers its diagnostics until a reference makes
// them relevant; these references are what makes them count.
new Impl().usesLimit();
const gaRef = GenericAbstract;
new Aliased();
new BareRepeat();
new RetypedRepeat();
// A refused override does not reject its class: the construction
// compiles, and the call through the class is what reports it.
const shorter = new Shorter();
shorter.feed();

// A shorter override that a subclass overrides again, called through its
// own class: the virtual slot still takes every inherited argument, and a
// parameter that cannot be omitted has no value to pass.
class Needs {
  need(name: string, weight: number): string {
    return `${name} ${weight}`;
  }
}
class NeedsNone extends Needs {
  need(): string {
    return "mid";
  }
}
class NeedsNoneBelow extends NeedsNone {
  need(): string {
    return "low";
  }
}
const needsNone: NeedsNone = new NeedsNoneBelow();
needsNone.need();
// A shorter override read as a value through its own class: the value is
// the slot function, which takes the inherited parameters.
const neededValue = new NeedsNoneBelow().need;
neededValue.call(needsNone);
