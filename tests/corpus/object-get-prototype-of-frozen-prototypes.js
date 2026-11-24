// Freezing, sealing or making a primitive prototype non-extensible must not
// let a later constructor seed write past the property table, and the
// constructor that was there when the program froze the prototype stays
// readable.
console.log("number-constructor", typeof Number.prototype.constructor === "function");
Object.freeze(Number.prototype);
console.log("number-frozen", Object.isFrozen(Number.prototype));
console.log("number-after", typeof Number.prototype.constructor === "function");
console.log("number-box", new Number(2).valueOf() === 2);
console.log("boolean-constructor", typeof Boolean.prototype.constructor === "function");
Object.preventExtensions(Boolean.prototype);
console.log("boolean-extensible", Object.isExtensible(Boolean.prototype));
console.log("boolean-after", typeof Boolean.prototype.constructor === "function");
console.log("boolean-box", new Boolean(true).valueOf() === true);
const stringProto = Object.getPrototypeOf("");
Object.seal(stringProto);
console.log("string-sealed", Object.isSealed(stringProto));
console.log("string-identity", Object.getPrototypeOf("x") === stringProto);
// A prototype obtained through getPrototypeOf and frozen before any
// constructor is seeded must not corrupt the property table.
const numberProto = Object.getPrototypeOf(5);
Object.freeze(numberProto);
console.log("proto-frozen", Object.isFrozen(numberProto));
console.log("proto-object", typeof numberProto === "object");
