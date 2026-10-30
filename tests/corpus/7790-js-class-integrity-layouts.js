"use strict";
// Object.freeze, Object.seal and Object.preventExtensions next to JavaScript
// classes whose fields all exist from construction. The integrity state of
// a class instance lives beside its fields, so classes keep fixed layouts
// whether or not a program freezes values; frozen instances still refuse
// writes and additions as in Node.

class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  norm() {
    return Math.abs(this.x) + Math.abs(this.y);
  }
}

class Point3 extends Point {
  constructor(x, y, z) {
    super(x, y);
    this.z = z;
  }
  norm() {
    return super.norm() + Math.abs(this.z);
  }
}

class Status {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid") this.value = "dirty";
  }
}

/** @param {any} target @param {string} key @param {unknown} value */
function put(target, key, value) {
  target[key] = value;
}

/** @param {any} value */
function describe(value) {
  const keys = Object.keys(value);
  const parts = [];
  for (const key in value) parts.push(`${key}=${String(value[key])}`);
  return `${keys.join(",")} | ${parts.join(" ")} | ${JSON.stringify(value)}`;
}

/** @param {() => void} fn */
function attempt(label, fn) {
  try {
    fn();
    console.log(label, "ok");
  } catch (e) {
    console.log(label, e instanceof TypeError ? "TypeError" : "other", e.message);
  }
}

// The zod shape: freeze whatever value a result carries. Here it is always
// plain data, never a class instance.
/** @param {{ status: string, value: any }} data */
function freezeResult(data) {
  if (data.status === "valid") data.value = Object.freeze(data.value);
  return data;
}

const results = [
  freezeResult({ status: "valid", value: { a: 1, list: [1, 2] } }),
  freezeResult({ status: "valid", value: [3, 4] }),
  freezeResult({ status: "aborted", value: { b: 2 } }),
  freezeResult({ status: "valid", value: "text" }),
];
for (const result of results) console.log(result.status, Object.isFrozen(result.value), JSON.stringify(result.value));
/** @param {() => void} fn */
function throws(fn) {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof TypeError;
  }
}
console.log(throws(() => put(results[0].value, "a", 9)), throws(() => put(results[2].value, "b", 3)));
console.log(JSON.stringify(results[2].value));

// Class instances that only ever travel through untyped code.
const status = new Status();
status.dirty();
const p = new Point(1, -2);
const q = new Point3(3, 4, -5);
put(p, "tag", "p");
put(q, "w", 6);
console.log(describe(status), status.value);
console.log(describe(p), p.norm());
console.log(describe(q), q.norm());
console.log(Object.isFrozen(p), Object.isExtensible(q), Object.isSealed(status));

// Statically typed freeze, seal and preventExtensions of instances.
const frozen = new Point(5, 6);
Object.freeze(frozen);
attempt("frozen field write", () => {
  /** @type {Point} */ (frozen).x = 50;
});
attempt("frozen field write untyped", () => put(frozen, "y", 60));
attempt("frozen addition", () => put(frozen, "extra", 1));
console.log(describe(frozen), Object.isFrozen(frozen), Object.isSealed(frozen), Object.isExtensible(frozen));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(frozen, "x")));

const sealed = new Point3(1, 2, 3);
put(sealed, "before", true);
Object.seal(sealed);
attempt("sealed field write", () => {
  sealed.z = 30;
});
attempt("sealed added write", () => put(sealed, "before", false));
attempt("sealed addition", () => put(sealed, "after", 1));
console.log(describe(sealed), Object.isFrozen(sealed), Object.isSealed(sealed), Object.isExtensible(sealed));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(sealed, "z")));

const closed = new Status();
Object.preventExtensions(closed);
closed.dirty();
attempt("closed addition", () => put(closed, "more", 1));
console.log(describe(closed), Object.isFrozen(closed), Object.isExtensible(closed));

// A subclass instance frozen through its base type.
/** @type {Point} */
const asBase = new Point3(7, 8, 9);
Object.freeze(asBase);
attempt("frozen subclass field", () => put(asBase, "z", 90));
console.log(describe(asBase), asBase.norm(), Object.isFrozen(asBase));

// Fresh instances of the same classes stay writable.
const fresh = new Point3(0, 0, 0);
fresh.x = 1;
put(fresh, "y", 2);
put(fresh, "added", 3);
console.log(describe(fresh), fresh.norm(), Object.isFrozen(fresh));
