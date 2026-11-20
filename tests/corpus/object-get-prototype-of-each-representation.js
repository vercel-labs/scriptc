// Object.getPrototypeOf answers the real prototype for every value a
// program can hold: a primitive is boxed (String.prototype and friends), a
// function and a class answer Function.prototype, a handle its class
// prototype, and a null-prototype object null.
const nullPrototype = Object.create(null);
// String.prototype as a value does not compile yet (a separate bug), so a
// string's prototype is pinned by its own identity and by not being
// Object.prototype.
console.log("string", Object.getPrototypeOf("x") === Object.getPrototypeOf("y"));
console.log("string-object", typeof Object.getPrototypeOf("x") === "object");
console.log("string-not-object-proto", Object.getPrototypeOf("x") !== Object.prototype);
console.log("number", Object.getPrototypeOf(1) === Number.prototype);
console.log("boolean", Object.getPrototypeOf(true) === Boolean.prototype);
console.log("object", Object.getPrototypeOf({}) === Object.prototype);
console.log("nullproto", Object.getPrototypeOf(nullPrototype) === null);
console.log("array", Object.getPrototypeOf([1]) === Array.prototype);
function named() {}
console.log("function", Object.getPrototypeOf(named) === Function.prototype);
console.log("arrow", Object.getPrototypeOf(() => 0) === Function.prototype);
console.log("class", Object.getPrototypeOf(class C {}) === Function.prototype);
// Function.prototype is itself a function whose prototype is the object one:
// a walker must not see a cycle there.
console.log("function-prototype", Object.getPrototypeOf(Function.prototype) === Object.prototype);
console.log("date", Object.getPrototypeOf(new Date(0)) === Date.prototype);
console.log("map", Object.getPrototypeOf(new Map()) === Map.prototype);
console.log("set", Object.getPrototypeOf(new Set()) === Set.prototype);
console.log("regexp", typeof Object.getPrototypeOf(/x/) === "object");
console.log("promise", typeof Object.getPrototypeOf(Promise.resolve(1)) === "object");
console.log("error", Object.getPrototypeOf(new Error("e")) === Error.prototype);
class Instance {
  constructor() {
    this.a = 1;
  }
}
const instance = new Instance();
console.log("instance", Object.getPrototypeOf(instance) === Instance.prototype);
for (const missing of [null, undefined]) {
  try {
    Object.getPrototypeOf(missing);
    console.log("nullish", "no throw");
  } catch (error) {
    console.log("nullish", error.message);
  }
}
