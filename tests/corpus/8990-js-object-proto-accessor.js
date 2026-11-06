// Object.prototype's `__proto__` accessor (t262 W7): the getter answers the
// receiver's [[Prototype]] and the setter replaces it. A value that is
// neither an object nor null completes without a property, a chain that does
// not reach Object.prototype has no accessor, and a definition of `__proto__`
// on the receiver or its chain takes the ordinary assignment instead. The top
// level is sloppy code: a failed store there still throws the setter's own
// TypeError, which a strict function sees the same way.
console.log("read plain", ({}).__proto__ === Object.prototype);
const own = Object.getOwnPropertyNames({});
console.log("own names", own.length);

const proto = { x: 1 };
const o = {};
o.__proto__ = proto;
console.log("set object", o.x, o.__proto__ === proto, Object.getPrototypeOf(o) === proto);
console.log("set object own names", Object.getOwnPropertyNames(o).length);

const number = {};
number.__proto__ = 42;
console.log("set number", Object.getPrototypeOf(number) === Object.prototype, Object.getOwnPropertyNames(number).length, number.__proto__ === Object.prototype);

const text = {};
text.__proto__ = "text";
console.log("set string", Object.getPrototypeOf(text) === Object.prototype, Object.getOwnPropertyNames(text).length);

const bool = {};
bool.__proto__ = true;
console.log("set boolean", Object.getPrototypeOf(bool) === Object.prototype, Object.getOwnPropertyNames(bool).length);

const nil = {};
nil.__proto__ = null;
console.log("set null", Object.getPrototypeOf(nil) === null, nil.__proto__);

// JSON.parse answers a dynamic value, so this object takes the dynamic
// member path rather than a typed field read.
const parsed = JSON.parse('{"x": 1}');
console.log("dynamic read", parsed.__proto__ === Object.prototype);
parsed.__proto__ = proto;
console.log("dynamic write", parsed.x, parsed.__proto__ === proto);

const bare = Object.create(null);
console.log("null chain read", bare.__proto__);
bare.__proto__ = proto;
console.log("null chain write", bare.__proto__ === proto, Object.getPrototypeOf(bare) === null);

const shadowBase = {};
Object.defineProperty(shadowBase, "__proto__", { value: 7, writable: true, enumerable: true });
const shadow = Object.create(shadowBase);
console.log("shadowed read", shadow.__proto__);
shadow.__proto__ = 9;
console.log("shadowed write", shadow.__proto__, Object.getPrototypeOf(shadow) === shadowBase);

const arrayShadowBase = {};
Object.defineProperty(arrayShadowBase, "__proto__", { value: 7, writable: true, enumerable: true });
const shadowedList = JSON.parse("[1, 2]");
Object.setPrototypeOf(shadowedList, arrayShadowBase);
console.log("array shadowed read", shadowedList.__proto__);
shadowedList.__proto__ = 9;
console.log("array shadowed write", shadowedList.__proto__, Object.getPrototypeOf(shadowedList) === arrayShadowBase);

const sealed = {};
Object.preventExtensions(sealed);
try {
  sealed.__proto__ = proto;
  console.log("sloppy non-extensible", "no throw");
} catch (e) {
  console.log("sloppy non-extensible", e.name);
}

const a = {};
const b = {};
a.__proto__ = b;
try {
  b.__proto__ = a;
  console.log("cyclic", "no throw");
} catch (e) {
  console.log("cyclic", e.name, e.message);
}

function strictWrites() {
  "use strict";
  const strictSealed = {};
  Object.preventExtensions(strictSealed);
  try {
    strictSealed.__proto__ = proto;
    console.log("strict non-extensible", "no throw");
  } catch (e) {
    console.log("strict non-extensible", e.name);
  }
  const strictNil = {};
  strictNil.__proto__ = null;
  console.log("strict null", Object.getPrototypeOf(strictNil) === null, strictNil.__proto__);
}
strictWrites();

console.log("in operator", "__proto__" in o, "__proto__" in bare);
