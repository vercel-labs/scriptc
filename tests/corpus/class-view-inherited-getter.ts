// An inherited getter: the view of a derived instance answers the member
// through the getter its base declares, or the intermediate class that
// overrides it, exactly as the instance does.

interface Identified {
  readonly id: number;
  readonly name: string;
}

interface Keyed {
  readonly id: number;
}

class Base {
  private identifier: number;
  constructor(id: number) {
    this.identifier = id;
  }
  get id(): number {
    return this.identifier;
  }
}

class Leaf extends Base {
  readonly name: string;
  constructor(id: number, name: string) {
    super(id);
    this.name = name;
  }
}

class Doubled extends Base {
  get id(): number {
    return super.id * 2;
  }
}

function describe(value: unknown): string {
  const identified = value as Identified;
  return `${identified.id}:${identified.name}`;
}

function identify(value: unknown): number {
  const keyed = value as Keyed;
  return keyed.id;
}

console.log(describe(new Leaf(7, "leaf") as unknown));
console.log(identify(new Leaf(7, "leaf") as unknown));
console.log(identify(new Doubled(7) as unknown));
