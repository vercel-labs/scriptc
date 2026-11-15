// A member a subclass redeclares as another kind of member: the forms that
// refuse, each by name. The nearest declaration is the one JavaScript
// reads, so an inherited member never answers for a redeclaration that has
// no lowering.

// `super.label()` where the base class's nearest declaration is a getter.
class Base {
  static label(): string {
    return "base";
  }
}
class Mid extends Base {
  static get label(): () => string {
    return () => "mid getter";
  }
}
class Leaf extends Mid {
  static viaSuper(): string {
    return super.label();
  }
}
console.log(Leaf.viaSuper());

// A setter alone is the whole property: the call reads undefined.
class Sink extends Base {
  static last = "";
  static set label(make: () => string) {
    Sink.last = make();
  }
}
console.log(Sink.label());

// A static field without an initializer is the class's own property and
// holds undefined; the initialized field of the base class is not read.
class Counted {
  static count: number | undefined = 1;
}
class Uncounted extends Counted {
  static count: number | undefined;
}
console.log(Counted.count, Uncounted.count);

// A static method named by a string, and one named by a computed key.
class Quoted extends Base {
  static "label"(): string {
    return "quoted";
  }
}
class Keyed extends Base {
  static ["label"](): string {
    return "keyed";
  }
}
console.log(Quoted.label());
console.log(Keyed.label());

// The same redeclarations on instances are type errors; when the error is
// suppressed, the class refuses.
class Shape {
  label(): string {
    return "shape";
  }
  get size(): number {
    return 1;
  }
  get area(): () => number {
    return () => 2;
  }
}
class AccessorOverMethod extends Shape {
  // @ts-expect-error a method redeclared as an accessor
  get label(): () => string {
    return () => "accessor";
  }
}
class FieldOverAccessor extends Shape {
  // @ts-expect-error an accessor redeclared as a field
  size = 10;
}
class MethodOverAccessor extends Shape {
  // @ts-expect-error an accessor redeclared as a method
  area(): number {
    return 20;
  }
}
console.log(new Shape().label(), new AccessorOverMethod().size);
console.log(new FieldOverAccessor().label());
console.log(new MethodOverAccessor().size);
