// A class as a bundler writes it: a class expression in a variable, with a
// private field that holds an arrow function, a private method and a public
// arrow field, each called by a public method.
var Reader = class {
  label;
  cache = {};
  #load = (key) => {
    const { cache, label } = this;
    return (cache[key] ??= Promise.resolve(`${label}:${key}`));
  };
  #twice(x) {
    return x + x;
  }
  plain = (key) => `${this.label}/${key}`;
  constructor(label) {
    this.label = label;
  }
  viaPrivateField() {
    return this.#load("text").then((t) => t.toUpperCase());
  }
  viaPrivateMethod() {
    return this.#twice(this.label);
  }
  viaPublicField() {
    return this.plain("k");
  }
  viaNothing() {
    return this.label;
  }
};
export { Reader };
