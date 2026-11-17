// Object.getPrototypeOf on a primitive answers the one wrapper prototype the
// program's Number.prototype / String.prototype / Boolean.prototype read
// reaches, whichever is used first.
console.log("number", Object.getPrototypeOf(1) === Number.prototype);
console.log("number-stable", Object.getPrototypeOf(1) === Object.getPrototypeOf(2));
console.log("string", String.prototype === Object.getPrototypeOf("x"));
console.log("boolean", Object.getPrototypeOf(true) === Boolean.prototype);
console.log("constructors", Number.prototype.constructor === Number, String.prototype.constructor === String);
console.log("chain", Object.getPrototypeOf(Object.getPrototypeOf(1)) === Object.prototype);
console.log("members", (1).toFixed(1), "abc".slice(1));
// The prototypes are wrappers themselves (Node's Number.prototype is a
// Number with the primitive slot 0), so their valueOf and tag answer the
// primitive brand.
console.log(
  "prototype values",
  Number.prototype.valueOf(),
  JSON.stringify(String.prototype.valueOf()),
  Boolean.prototype.valueOf(),
);
console.log("prototype tag", Object.prototype.toString.call(Number.prototype));
