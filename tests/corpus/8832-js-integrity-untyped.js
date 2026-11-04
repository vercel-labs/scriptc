// Object.preventExtensions, isExtensible, seal, isSealed, freeze and isFrozen
// answer and mutate through a dynamic value: seal keeps the elements
// writable, freeze does not, and a non-extensible array still accepts a
// writable length shrink. Node is the oracle.
function attempt(name, f) {
  try {
    console.log(name, "OK", JSON.stringify(f()));
  } catch (e) {
    console.log(name, "THROW", e.name, e.message);
  }
}

// The value arrives at each helper through a parameter whose type is not
// known, so the integrity operations run against a checked-dynamic value.
/** @param {any} value */
function dyn(value) {
  return value;
}

attempt("missing-argument", () => [
  Object.isExtensible(),
  Object.isSealed(),
  Object.isFrozen(),
  Object.preventExtensions(),
  Object.seal(),
  Object.freeze(),
]);

attempt("primitives", () => [
  Object.isExtensible(5),
  Object.isSealed("x"),
  Object.isFrozen(true),
  Object.preventExtensions(7),
]);

attempt("object", () => {
  const o = dyn({ a: 1 });
  const before = [Object.isExtensible(o), Object.isSealed(o), Object.isFrozen(o)];
  Object.preventExtensions(o);
  return before.concat([Object.isExtensible(o), Object.isSealed(o), Object.isFrozen(o)]);
});

attempt("seal", () => {
  const o = dyn({ a: 1 });
  Object.seal(o);
  o.a = 2;
  let added = "added";
  try {
    o.b = 3;
    added = String(o.b);
  } catch (e) {
    added = e.name + " " + e.message;
  }
  return [Object.isSealed(o), Object.isExtensible(o), Object.isFrozen(o), o.a, added];
});

attempt("freeze", () => {
  const o = dyn({ a: 1, b: 2 });
  Object.freeze(o);
  // A strict-mode write to a frozen property throws; the value stays.
  let write = "written";
  try {
    o.a = 9;
  } catch (e) {
    write = e.name + " " + e.message;
  }
  let redefined = "redefined";
  try {
    Object.defineProperty(o, "b", { value: 3 });
  } catch (e) {
    redefined = e.name + " " + e.message;
  }
  return [write, redefined, Object.isFrozen(o), Object.isSealed(o), Object.isExtensible(o), o.a, o.b, Object.keys(o)];
});

attempt("seal-array", () => {
  const a = dyn([1, 2]);
  Object.seal(a);
  a[0] = 5;
  return [Object.isSealed(a), Object.isFrozen(a), Object.isExtensible(a), JSON.stringify(a)];
});

attempt("freeze-array", () => {
  const a = dyn([1, 2]);
  Object.freeze(a);
  const writes = [() => (a[0] = 5), () => a.push(3), () => (a.length = 1)];
  const labels = ["write", "push", "length"];
  const failures = [];
  for (let i = 0; i < writes.length; i++) {
    try {
      writes[i]();
      failures.push(labels[i] + " OK");
    } catch (e) {
      failures.push(labels[i] + " " + e.name + " " + e.message);
    }
  }
  return [failures, Object.isFrozen(a), JSON.stringify(a), a.length];
});

attempt("prevent-extensions-array", () => {
  const a = dyn([1, 2]);
  Object.preventExtensions(a);
  const push = (() => {
    try {
      a.push(3);
      return "pushed";
    } catch (e) {
      return e.name + " " + e.message;
    }
  })();
  a.length = 1;
  return [push, a.length, JSON.stringify(a), Object.isExtensible(a), Object.isSealed(a)];
});

attempt("define-on-sealed", () => {
  const o = dyn({ a: 1 });
  Object.seal(o);
  try {
    Object.defineProperty(o, "b", { value: 2 });
    return "defined";
  } catch (e) {
    return [e.name, e.message];
  }
});

attempt("repeat", () => {
  const o = dyn({ a: 1 });
  Object.preventExtensions(o);
  Object.preventExtensions(o);
  Object.seal(o);
  Object.freeze(o);
  return [Object.isFrozen(o), Object.isSealed(o), Object.isExtensible(o), o.a];
});

// Element descriptors can make an array sealed or frozen after a
// preventExtensions, without the whole-array flags Object.seal and
// Object.freeze set. A hole is not an own property, so it does not count.
attempt("seal-array-by-elements", () => {
  const a = dyn([1, 2]);
  Object.preventExtensions(a);
  Object.defineProperty(a, "0", { configurable: false });
  Object.defineProperty(a, "1", { configurable: false });
  const sealed = [Object.isSealed(a), Object.isFrozen(a)];
  Object.defineProperty(a, "0", { writable: false, configurable: false });
  Object.defineProperty(a, "1", { writable: false, configurable: false });
  return sealed.concat([Object.isSealed(a), Object.isFrozen(a)]);
});

attempt("frozen-array-with-hole", () => {
  const a = dyn([1, 3]);
  a.length = 4;
  Object.preventExtensions(a);
  Object.defineProperty(a, "0", { writable: false, configurable: false });
  Object.defineProperty(a, "1", { writable: false, configurable: false });
  return [Object.isSealed(a), Object.isFrozen(a), 2 in a, Object.keys(a)];
});

// A non-writable element that is still configurable does not seal the array.
attempt("sealed-array-writable-element", () => {
  const a = dyn([1]);
  Object.preventExtensions(a);
  Object.defineProperty(a, "0", { writable: false });
  Object.defineProperty(a, "length", { writable: false });
  return [Object.isSealed(a), Object.isFrozen(a)];
});

// An empty array is sealed, and frozen too, once it cannot extend: it has
// no element to keep writable.
attempt("empty-array-prevent-extensions", () => {
  const a = dyn([]);
  Object.preventExtensions(a);
  return [Object.isSealed(a), Object.isFrozen(a), Object.isExtensible(a)];
});
