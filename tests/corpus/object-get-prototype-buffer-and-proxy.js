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
