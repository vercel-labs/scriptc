// JSDoc optionality describes the value, not the setter's executable arity.
class Store {
  constructor() {
    /** @type {string | null | undefined} */
    this.stored = undefined;
  }
  /** @param {string | null} [next] */
  set value(next) {
    console.log("set", next);
    this.stored = next;
  }
  /** @returns {string | null | undefined} */
  get value() {
    return this.stored;
  }
}

const store = new Store();
store.value = "first";
console.log("get", store.value);
store.value = null;
console.log("get", store.value === null);
store.value = undefined;
console.log("get", store.value === undefined);

class Child extends Store {}
const child = new Child();
child.value = "child";
console.log("inherited", child.value);

// Generated wrappers can accept null in the setter and normalize it to
// undefined, while the getter documents only the value that comes back.
class Normalized {
  constructor() {
    /** @type {string | undefined} */
    this.stored = undefined;
  }
  /** @returns {string | undefined} */
  get value() {
    return this.stored;
  }
  /** @param {string | null} [next] */
  set value(next) {
    this.stored = next ?? undefined;
  }
}
const normalized = new Normalized();
normalized.value = "text";
console.log("normalized", normalized.value);
normalized.value = null;
console.log("normalized", normalized.value === undefined);

const sink = {
  /** @param {string | null} [next] */
  set value(next) {
    console.log("sink", next);
  },
};
console.log("arity", Object.getOwnPropertyDescriptor(sink, "value").set.length);
sink.value = "object";
sink.value = null;
sink.value = undefined;
