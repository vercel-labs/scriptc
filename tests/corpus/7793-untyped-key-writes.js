"use strict";
// Untyped property writes through one site: new keys append in order,
// existing keys keep their position, own and inherited setters run,
// getter-only and read-only properties refuse the write, and
// non-extensible objects refuse new keys, as in Node.

/** @param {any} target @param {string} key @param {unknown} value */
function put(target, key, value) {
  target[key] = value;
}

/** @param {() => void} fn */
function attempt(label, fn) {
  try {
    fn();
    console.log(label, "ok");
  } catch (e) {
    console.log(label, e instanceof TypeError ? "TypeError" : String(e));
  }
}

const order = {};
for (const key of ["b", "a", "c", "a", "b", "d"]) put(order, key, key.charCodeAt(0));
console.log(JSON.stringify(order), Object.keys(order).join(""));

const log = [];
const withSetter = {
  _v: 0,
  get v() {
    return this._v;
  },
  set v(value) {
    log.push(`own ${value}`);
    this._v = value * 2;
  },
  get onlyGetter() {
    return "g";
  },
};
put(withSetter, "v", 4);
console.log(withSetter.v, JSON.stringify(log));
attempt("getter-only", () => put(withSetter, "onlyGetter", 1));

const proto = {
  /** @param {number} value */
  set inherited(value) {
    log.push(`inherited ${value} on ${this === child}`);
  },
};
Object.defineProperty(proto, "fixed", { value: 1, writable: false });
const child = Object.create(proto);
put(child, "inherited", 7);
attempt("inherited read-only", () => put(child, "fixed", 2));
put(child, "own", 3);
console.log(JSON.stringify(log), Object.keys(child).join(","), child.fixed);

/** @type {any} */
const sealed = { x: 1 };
Object.seal(sealed);
put(sealed, "x", 2);
attempt("sealed add", () => put(sealed, "y", 3));
/** @type {any} */
const closed = { x: 1 };
Object.preventExtensions(closed);
put(closed, "x", 5);
attempt("closed add", () => put(closed, "z", 1));
const frozen = Object.freeze({ x: 1 });
attempt("frozen write", () => put(frozen, "x", 9));
console.log(JSON.stringify(sealed), JSON.stringify(closed), JSON.stringify(frozen));

const readOnly = {};
Object.defineProperty(readOnly, "k", { value: "kept", writable: false, enumerable: true });
attempt("own read-only", () => put(readOnly, "k", "changed"));
console.log(readOnly.k);

const error = new Error("boom");
put(error, "cause", "why");
put(error, "code", "E_X");
console.log(error.cause, error.code);

const wide = {};
for (let i = 0; i < 40; i++) put(wide, `k${i % 25}`, i);
console.log(Object.keys(wide).length, wide.k0, wide.k24, Object.keys(wide).slice(0, 3).join(","));
