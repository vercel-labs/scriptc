// `super()` into a constructor that can return an existing instance would
// rebind the subclass's `this` to that instance.
class Shared {
  static one: Shared | undefined = undefined;
  constructor() {
    if (Shared.one) return Shared.one;
    Shared.one = this;
  }
}
class Derived extends Shared {
  constructor() {
    super();
  }
}
console.log(new Derived() instanceof Derived);
