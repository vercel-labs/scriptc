// A function-local subclass refuses new.target in its base's constructor
// also when lowering collects it after that constructor: make() is lowered
// after the top-level code that constructs Base.
class Base {
  readonly label: string;
  constructor() {
    this.label = new.target.name;
  }
}
console.log(new Base().label);
function make(): Base {
  const Local = class extends Base {};
  return new Local();
}
console.log(make().label);
