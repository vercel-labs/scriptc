// A static member a subclass redeclares as another kind of member: the
// nearest declaration answers, whatever its kind, as an own property of the
// class does in JavaScript. A call of a static getter is a call of the
// function the getter answers.
const trace: string[] = [];

class Base {
  static label(): string {
    return "base";
  }
  static describe(): string {
    return "<" + this.label() + ">";
  }
}
class Derived extends Base {
  static get label(): () => string {
    trace.push("Derived.label read");
    return () => "derived getter";
  }
}
class Leaf extends Derived {}
class Again extends Derived {
  static label(): string {
    return "again method";
  }
}

// A method redeclared as a getter: through the class name, through `this`
// in an inherited static method, through a subclass that declares nothing,
// and through one that declares a method again.
console.log(Base.label(), Derived.label(), Leaf.label(), Again.label());
console.log(Base.describe(), Derived.describe(), Leaf.describe(), Again.describe());
console.log(trace.length, trace[0]);

// Read as a value, each answers its own declaration.
const fromBase = Base.label;
const fromDerived = Derived.label;
console.log(fromBase(), fromDerived(), typeof Derived.label, Base.label === Base.label);

// The reverse: a getter redeclared as a method.
class Named {
  static get title(): () => string {
    return () => "named getter";
  }
  static show(): string {
    return this.title();
  }
}
class Renamed extends Named {
  static title(): string {
    return "renamed method";
  }
}
console.log(Named.title(), Renamed.title(), Named.show(), Renamed.show());

// A field that holds a function, redeclared as a getter and as a field
// again below it.
class Held {
  static pick: () => string = () => "held field";
  static run(): string {
    return this.pick();
  }
}
class HeldGetter extends Held {
  static get pick(): () => string {
    return () => "getter over field";
  }
}
class HeldAgain extends HeldGetter {
  static pick: () => string = () => "field over getter";
}
console.log(Held.pick(), HeldGetter.pick(), HeldAgain.pick());
console.log(Held.run(), HeldGetter.run(), HeldAgain.run());

// A generic static method redeclared as a getter.
class Keeps {
  static keep<U>(v: U): U {
    return v;
  }
}
class KeepsLoudly extends Keeps {
  static get keep(): <U>(v: U) => U {
    trace.push("KeepsLoudly.keep read");
    return <U,>(v: U): U => v;
  }
}
console.log(Keeps.keep(1), KeepsLoudly.keep(2), Keeps.keep("s"), trace[trace.length - 1]);

// A getter with no inherited member of the name, called with arguments. The
// getter runs before the arguments are evaluated, once for each call.
let reads = 0;
let made = 0;
function next(): number {
  made++;
  trace.push("argument " + made);
  return made;
}
class Maker {
  static get make(): (n: number, suffix?: string) => string {
    reads++;
    trace.push("Maker.make read " + reads);
    return (n: number, suffix?: string) => "made " + n + (suffix ?? "");
  }
  static viaThis(): string {
    return this.make(7);
  }
}
class SubMaker extends Maker {
  static get make(): (n: number, suffix?: string) => string {
    return (n: number, suffix?: string) => "sub made " + n + (suffix ?? "");
  }
}
console.log(Maker.make(next()), Maker.make(next(), "!"), SubMaker.make(3));
console.log(Maker.viaThis(), SubMaker.viaThis(), reads);
console.log(trace.slice(-5).join(" | "));

// Getters that answer a value: a subclass's getter, one half of a pair
// redeclared, and a `declare` field, which is erased and leaves the name to
// the base class.
class Sized {
  static stored = 1;
  static get size(): number {
    return Sized.stored;
  }
  static set size(v: number) {
    Sized.stored = v;
  }
  static total(): number {
    return this.size + 1;
  }
  static count = 4;
}
class Fixed extends Sized {
  static get size(): number {
    return 100;
  }
  declare static count: number;
}
console.log(Sized.size, Fixed.size, Sized.total(), Fixed.total(), Fixed.count);
Sized.size = 5;
console.log(Sized.size, Fixed.size, Sized.total(), Fixed.total());

// The receiver is evaluated once, before the getter runs: a getter that
// rebinds the variable the class was read from does not change the class
// its function is called on.
class Origin {
  static get who(): (this: typeof Origin) => string {
    holder = Moved;
    return function (this: typeof Origin): string {
      return this === Origin ? "called on Origin" : "called on another class";
    };
  }
}
class Moved extends Origin {}
let holder: typeof Origin = Origin;
console.log(holder.who(), holder === Moved);
console.log(Origin.who());

