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
