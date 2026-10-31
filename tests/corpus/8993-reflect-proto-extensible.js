// Reflect.getPrototypeOf / setPrototypeOf / isExtensible / preventExtensions:
// the Object operations with Reflect's shape. A non-object target throws, and
// the two mutators answer the boolean instead of throwing.
const plain = { value: 1 };
console.log(Reflect.getPrototypeOf(plain) === Object.prototype);
console.log(Reflect.getPrototypeOf([]) === Array.prototype);
console.log(Reflect.getPrototypeOf(Object.create(null)));
const base = { inherited: true };
const child = Object.create(base);
console.log(Reflect.getPrototypeOf(child) === base, child.inherited);
console.log(Reflect.setPrototypeOf(child, null), Reflect.getPrototypeOf(child));
console.log(child.inherited, Reflect.setPrototypeOf(child, base), child.inherited);
function fn() {}
console.log(Reflect.isExtensible(plain), Reflect.isExtensible(fn), Reflect.isExtensible([]));
const frozen = Object.create(base);
Object.preventExtensions(frozen);
console.log(Reflect.isExtensible(frozen), Reflect.preventExtensions(frozen));
console.log(Reflect.setPrototypeOf(frozen, { other: true }), Reflect.getPrototypeOf(frozen) === base);
const detached = Object.create(base);
console.log(Reflect.setPrototypeOf(detached, null), Reflect.isExtensible(detached));

try { Reflect.getPrototypeOf(1); } catch (error) { console.log(error.name, error.message); }
try { Reflect.getPrototypeOf(null); } catch (error) { console.log(error.name, error.message); }
try { Reflect.getPrototypeOf(undefined); } catch (error) { console.log(error.name, error.message); }
try { Reflect.setPrototypeOf("text", null); } catch (error) { console.log(error.name, error.message); }
try { Reflect.isExtensible(true); } catch (error) { console.log(error.name); }
try { Reflect.preventExtensions(0); } catch (error) { console.log(error.name); }
try { Reflect.setPrototypeOf({}, 1); } catch (error) { console.log(error.name); }

// Through a proxy: the traps answer, and the target invariants are enforced.
const trapLog = [];
const protoTarget = { name: "target" };
const protoProxy = new Proxy(protoTarget, {
  getPrototypeOf(target) { trapLog.push("getPrototypeOf"); return Array.prototype; },
  setPrototypeOf(target, proto) { trapLog.push("setPrototypeOf:" + (proto === null)); return true; },
  isExtensible(target) { trapLog.push("isExtensible"); return true; },
  preventExtensions(target) { trapLog.push("preventExtensions"); Object.preventExtensions(target); return true; },
});
console.log(Reflect.getPrototypeOf(protoProxy) === Array.prototype);
console.log(Reflect.setPrototypeOf(protoProxy, null), Reflect.isExtensible(protoProxy));
console.log(Reflect.preventExtensions(protoProxy), trapLog.join("|"));

// A getPrototypeOf trap that disagrees with a non-extensible target throws.
const pinnedTarget = { name: "pinned" };
Object.preventExtensions(pinnedTarget);
const pinned = new Proxy(pinnedTarget, { getPrototypeOf() { return Array.prototype; } });
try { Reflect.getPrototypeOf(pinned); } catch (error) { console.log(error.name); }
console.log(Reflect.getPrototypeOf(new Proxy(pinnedTarget, {})) === Object.prototype);

// An isExtensible trap that disagrees with the target throws.
const lyingExtensible = new Proxy({}, { isExtensible() { return false; } });
try { Reflect.isExtensible(lyingExtensible); } catch (error) { console.log(error.name); }
// A preventExtensions trap that leaves the target extensible throws.
const lyingPrevent = new Proxy({}, { preventExtensions() { return true; } });
try { Reflect.preventExtensions(lyingPrevent); } catch (error) { console.log(error.name); }
// A setPrototypeOf trap that refuses answers false without throwing.
const refusing = new Proxy({}, { setPrototypeOf() { return false; } });
console.log(Reflect.setPrototypeOf(refusing, null), Reflect.getPrototypeOf(refusing) === Object.prototype);

// A trap that is missing forwards to the target, whose answer stands.
const forwarded = new Proxy({ own: 1 }, {});
console.log(Reflect.getPrototypeOf(forwarded) === Object.prototype, Reflect.isExtensible(forwarded));
