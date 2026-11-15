// A JSDoc-typed static field stores the values a program writes outside
// its annotation, as Node does: the written value keeps its identity and
// class through reads, `instanceof` and `===`, and a logical assignment
// stores there too.

class Base {
  constructor() {
    this.kind = 0;
  }
}
class Other {
  constructor() {
    this.other = 1;
  }
}

class Holder {
  /** @type {Base | undefined} */
  static item = new Base();
}

const other = new Other();
Holder.item = other;
console.log(Holder.item === other, Holder.item instanceof Other, Holder.item instanceof Base);

Holder.item ||= new Base();
console.log(Holder.item instanceof Base, Holder.item instanceof Other);

Holder.item = undefined;
console.log(Holder.item === undefined);

class Logical {
  /** @type {Base | undefined} */
  static slot = undefined;
}
Logical.slot ||= other;
console.log(Logical.slot === other, Logical.slot instanceof Other, Logical.slot instanceof Base);
