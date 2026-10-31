// The Object operations over a proxy: getPrototypeOf, setPrototypeOf,
// isExtensible and preventExtensions run the matching trap and enforce the
// same invariants Reflect does. Object.setPrototypeOf throws when the trap
// refuses; Reflect answers false.
const target = { value: 1 };
const log = [];
const proxy = new Proxy(target, {
  getPrototypeOf(t) { log.push("getPrototypeOf:" + (t === target)); return Object.prototype; },
  setPrototypeOf(t, proto) { log.push("setPrototypeOf:" + (proto === null)); return false; },
  isExtensible(t) { log.push("isExtensible:" + (t === target)); return true; },
  preventExtensions(t) { log.push("preventExtensions"); return false; },
});
console.log(Object.getPrototypeOf(proxy) === Object.prototype, log.join("|"));
console.log(Reflect.getPrototypeOf(proxy) === Object.prototype);
console.log(Reflect.setPrototypeOf(proxy, null), Object.getPrototypeOf(target) === Object.prototype);
try { Object.setPrototypeOf(proxy, null); } catch (error) { console.log(error.name); }
console.log(Object.isExtensible(proxy));
try { Object.preventExtensions(proxy); } catch (error) { console.log(error.name); }
console.log(log.join("|"));

// A trap that is absent forwards to the target.
const forwarded = new Proxy({ own: 1 }, {});
console.log(Object.getPrototypeOf(forwarded) === Object.prototype, Object.isExtensible(forwarded));
const nullProto = new Proxy(Object.create(null), {});
console.log(Object.getPrototypeOf(nullProto));

// The trap receives the raw target, not the proxy, and the answer is the
// trap's own object.
const customProto = { custom: true };
const trapOnly = new Proxy(target, { getPrototypeOf() { return customProto; } });
console.log(Object.getPrototypeOf(trapOnly) === customProto, "custom" in trapOnly);

// An inherited method read through the proxy's own prototype.
const methodProto = { greet() { return "hello"; } };
const methodProxy = new Proxy(target, { getPrototypeOf() { return methodProto; } });
console.log(Object.getPrototypeOf(methodProxy).greet());
