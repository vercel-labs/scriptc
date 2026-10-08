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

// overrides must keep the exact signature (method bivariance is unsound
// through a vtable)
class Bivariant extends Animal {
  feed(other: Bivariant): string {
    return other.name;
  }
}

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

// ...and folds statically for standalone classes, so a computed operand
// whose effects would be dropped is rejected
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
new Bivariant();
