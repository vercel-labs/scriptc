// A buffer answers ArrayBuffer.prototype (the object the program's
// ArrayBuffer.prototype read answers), not a fabricated per-kind object, and
// a Proxy answers its target's prototype.
const buffer = new ArrayBuffer(1);
console.log("arraybuffer", Object.getPrototypeOf(buffer) === ArrayBuffer.prototype);
console.log("arraybuffer-object", Object.getPrototypeOf(buffer) !== Object.prototype);

const proxy = new Proxy({}, {});
console.log("proxy", Object.getPrototypeOf(proxy) === Object.prototype);
const nullProto = Object.create(null);
console.log("proxy-null", Object.getPrototypeOf(new Proxy(nullProto, {})) === null);

// A trap's result may be any object: an array or a function.
const arrayHandler = /** @type {any} */ ({});
arrayHandler.getPrototypeOf = () => [];
console.log("proxy-trap-array-result", Object.getPrototypeOf(new Proxy({}, arrayHandler)) instanceof Array);
const functionHandler = /** @type {any} */ ({});
function target() {}
functionHandler.getPrototypeOf = () => target;
console.log("proxy-trap-function-result", typeof Object.getPrototypeOf(new Proxy({}, functionHandler)) === "function");

// A non-extensible function target fixes the trap's answer.
function frozenTarget() {}
Object.preventExtensions(frozenTarget);
try {
  Object.getPrototypeOf(new Proxy(frozenTarget, { getPrototypeOf: () => null }));
  console.log("function-invariant", "no throw");
} catch (error) {
  console.log("function-invariant", error.name, error.message);
}
