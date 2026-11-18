// A base constructor that returns an existing instance, in JavaScript:
// `new Element()` answers the element that already exists when it is an
// instance of the class being constructed, and the class's field
// initializers and constructor body run on it, as in Node.
let upgrading = null;
class BaseElement {
  constructor() {
    this.tagName = "x-base";
    if (upgrading !== null) {
      const existing = upgrading;
      upgrading = null;
      return existing;
    }
  }
}
class CounterElement extends BaseElement {
  count = 0;
  constructor() {
    super();
    this.count += 1;
    this.upgraded = this.tagName === "x-counter";
  }
  increment() {
    return ++this.count;
  }
}

const element = new CounterElement();
element.tagName = "x-counter";
element.increment();
const references = [element];
upgrading = element;
const upgraded = new CounterElement();
console.log(upgraded === references[0], upgraded.count, upgraded.upgraded, upgraded.increment());
const registry = new Map([["x-counter", CounterElement]]);
upgrading = element;
const viaRegistry = new (registry.get("x-counter"))();
console.log(viaRegistry === element, viaRegistry.count, new CounterElement() === element);

// A function-local subclass constructs through its own environment.
function defineLocal() {
  class LocalElement extends BaseElement {
    local = true;
  }
  return new LocalElement();
}
console.log(defineLocal().local, defineLocal().tagName);
