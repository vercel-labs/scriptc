// new.target in a constructor whose subclasses are generic classes
// instantiated only in bodies lowered later, and classes whose own static
// `name` field replaces their name.
class Plain {
  readonly label: string;
  readonly plain: boolean;
  constructor() {
    this.label = new.target.name;
    this.plain = new.target === Plain;
  }
}
class Sub<T> extends Plain {
  readonly v: T;
  constructor(v: T) {
    super();
    this.v = v;
  }
}

class Box<T> {
  readonly label: string;
  readonly exact: boolean;
  readonly value: T;
  constructor(value: T) {
    this.value = value;
    this.label = new.target.name;
    this.exact = new.target === Leaf;
  }
}
class Tagged<T> extends Box<T> {}
class Leaf extends Tagged<number> {}

class Named {
  static name = "custom";
  readonly label: string;
  constructor() {
    this.label = new.target.name;
  }
}
class Child extends Named {}
class Other extends Named {
  static name = "other";
}
class Family<T> {
  static name = "family";
  readonly label: string;
  readonly v: T;
  constructor(v: T) {
    this.label = new.target.name;
    this.v = v;
  }
}

function later(): void {
  const n = new Sub<number>(1);
  const p = new Plain();
  console.log(n.label, new Sub<string>("s").label, p.label, n.plain, p.plain);
  const t = new Tagged<number>(1);
  const s = new Tagged<string>("a");
  const b = new Box<number>(2);
  const l = new Leaf(3);
  console.log(t.label, s.label, b.label, l.label, t.exact, l.exact, b.exact);
  console.log(new Family<boolean>(true).label);
}

// The bases construct here first; their subclasses only in later().
console.log(new Plain().label, new Box<boolean>(false).label);
console.log(new Named().label, new Child().label, new Other().label);
Named.name = "changed";
console.log(new Named().label, new Child().label, new Other().label);
later();
