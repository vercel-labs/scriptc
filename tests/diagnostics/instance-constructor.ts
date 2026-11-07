// Classes read as values through an instance or a static accessor: the
// forms that still refuse, each by name (tsc-clean, outside the subset).

// The constructor of a generic class's instance as a value: two
// instantiations are one class in JavaScript and two class objects here.
// Its name compiles.
class Box<T> {
  value: T | undefined = undefined;
}
const constructors: unknown[] = [new Box<number>().constructor];
console.log(constructors.length, new Box<number>().constructor.name);

// Binding the constructor as a class value when a subclass takes other
// constructor arguments: the bound value could not construct through the
// asserted type. Reading the static through the assertion compiles.
class Model {
  static table = "models";
  where(): string {
    const ctor = this.constructor as typeof Model;
    return ctor.table;
  }
  direct(): string {
    return (this.constructor as typeof Model).table;
  }
}
class Session extends Model {
  id: number;
  constructor(id: number) {
    super();
    this.id = id;
  }
}
console.log(new Session(1).where(), new Session(1).direct());

// A static setter with no getter reads undefined in JavaScript.
class Sink {
  static last = "";
  static set value(text: string) {
    Sink.last = text;
  }
}
console.log(Sink.value);

// A static accessor has no storage to update in place.
class Settings {
  static stored = 1;
  static get level(): number {
    return Settings.stored;
  }
  static set level(value: number) {
    Settings.stored = value;
  }
}
Settings.level += 1;
Settings.level++;

// A function-local class that extends another function-local class builds
// its prototype object with the class, one per evaluation, so the program
// can write it and `constructor` has no compiled answer there. A
// function-local class that extends a module-level class compiles.
function local(n: number): string {
  class Local {
    v = n;
  }
  class Inner extends Local {}
  const value: Local = new Inner();
  return value.constructor.name;
}
console.log(local(1));

// A function-local class is a new class object at each evaluation of its
// enclosing body: one evaluation's instance is not another evaluation's
// class.
class Base {}
const escaped: Base[] = [];
function probe(): boolean {
  class Local extends Base {}
  escaped.push(new Local());
  return escaped[0]!.constructor === Local;
}
console.log(probe());

// A subclass can replace an inherited static method with a function-valued
// getter: the instance's own class decides what the member read returns,
// so the call is not the inherited method.
class Namers {
  static make(): string {
    return "base";
  }
}
class GetterNamers extends Namers {
  static get make(): () => string {
    return () => "sub";
  }
}
function build(): Namers {
  return new GetterNamers();
}
console.log((build().constructor as typeof Namers).make());
