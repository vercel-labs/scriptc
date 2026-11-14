// #private-member FENCES: the shapes the private-members lowering refuses,
// each with the diagnostic naming the honest reason. Everything here is
// legal TypeScript that Node runs — the fences are representation limits,
// not type errors.

// A subclass redeclaring an inherited private NAME: JS gives each class its
// own distinct '#x' slot under one spelling; these layouts have one slot
// per name.
class RedeclareBase {
  #x = 1;
  read(): number {
    return this.#x;
  }
}
class RedeclareSub extends RedeclareBase {
  #x = 2;
  own(): number {
    return this.#x;
  }
}
const rs = new RedeclareSub();
console.log(rs.read());

// Extracted private methods are NOT auto-bound in JS (`f()` runs with
// `this` undefined) — the unbound value has no static story, the
// bound-method fence names it.
class Unbound {
  #m(): number {
    return 1;
  }
  grab(): () => number {
    const f = this.#m;
    return f;
  }
}
console.log(new Unbound().grab()());

// Brand checks need a receiver whose representation can HOLD a branded
// instance: 'unknown' values live in the checked-dynamic tree, which never carries class
// instances — the fence points at narrowing.
class BrandUnknown {
  #v = 3;
  static probe(o: unknown): boolean {
    return typeof o === "object" && o !== null && #v in o;
  }
}
console.log(BrandUnknown.probe(null));

// A private STATIC's brand lives on the declaring class OBJECT, not on
// instances — the instance-shaped test fences.
class StaticBrand {
  static #s(): number {
    return 1;
  }
  check(o: StaticBrand): boolean {
    return #s in o;
  }
}
console.log(new StaticBrand().check(new StaticBrand()));

// Private statics through class VALUES that may hold a DESCENDANT: with a
// subclass in the program, the slot can hold it at runtime and JS brands
// the declaring class object alone (exact receivers — the name, a const
// alias, a leaf class's values — compile).
class ViaValue {
  static #origin = 7;
  static read(k: typeof ViaValue): number {
    return k.#origin;
  }
}
class ViaValueSub extends ViaValue {}
console.log(ViaValue.read(ViaValueSub));

// A cast that erases the class value's type keeps that fence: the read is
// still of the private name, not of a public property of that spelling.
class ViaErasedValue {
  static #origin = 7;
  read(k: typeof ViaErasedValue): number {
    return (k as any).#origin;
  }
}
class ViaErasedValueSub extends ViaErasedValue {}
console.log(new ViaErasedValue().read(ViaErasedValueSub));

// The private name resolves in the enclosing class body, so through an
// erased cast it can name a class other than the receiver's.
class ForeignBrand {
  static #origin = 8;
  static label = "foreign";
}
class LexicalBrand {
  static #origin = 9;
  read(k: typeof ForeignBrand): number {
    return (k as any).#origin;
  }
}
console.log(ForeignBrand.label, new LexicalBrand().read(ForeignBrand));

// Generic classes share ONE brand across every instantiation in JS; these
// layouts mint one class per instantiation, so private-in fences there.
class GenBrand<T> {
  #tag = 1;
  same(o: GenBrand<number>): boolean {
    return #tag in o;
  }
}
console.log(new GenBrand<number>().same(new GenBrand<number>()));

// Positive control: async private generators use direct dispatch and the
// same request queue as module-level async generators.
class AsyncGen {
  async *#pump(): AsyncGenerator<number, void, undefined> {
    yield 1;
  }
  async drain(): Promise<void> {
    for await (const v of this.#pump()) console.log(v);
  }
}
const ag = new AsyncGen();
void ag.drain();
