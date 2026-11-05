"use strict";
// A promise holds own properties as any object does: code that tracks a
// thenable's state stores `status`, `value` and `reason` on the promise. The
// promises reach this code as untyped values, as thenables passed to a
// library do.
function untyped(value) {
  return value;
}
function track(thenable) {
  if (typeof thenable.status === "string") return thenable.status;
  thenable.status = "pending";
  thenable.then(
    (value) => {
      thenable.status = "fulfilled";
      thenable.value = value;
    },
    (reason) => {
      thenable.status = "rejected";
      thenable.reason = reason;
    },
  );
  return thenable.status;
}

const later = untyped(new Promise((resolve) => setTimeout(() => resolve(5), 1)));
const failing = untyped(Promise.reject(new Error("no")));
console.log(track(later), track(failing), "reason" in failing, "then" in later);
console.log(Object.keys(later), Object.hasOwn(later, "status"), Object.hasOwn(later, "then"));

setTimeout(() => {
  console.log(track(later), later.value, track(failing), "reason" in failing, failing.reason.message);
  console.log(Object.entries(later), JSON.stringify(later));
  for (const key in later) console.log("key", key);
  console.log(JSON.stringify({ ...later }));

  delete later.value;
  console.log(Object.keys(later), later.value);

  Object.defineProperty(later, "hidden", { value: 1, enumerable: false });
  console.log(Object.keys(later), later.hidden, Object.getOwnPropertyNames(later));
  console.log(Object.getOwnPropertyDescriptor(later, "status"));
  Object.defineProperty(later, "self", { get() { return this === later; } });
  console.log(later.self);

  console.log(later.propertyIsEnumerable("status"), later.propertyIsEnumerable("hidden"));

  // Object.assign reads each getter just before copying its value, and
  // JSON.stringify's replacer and indentation see promise properties.
  const getters = untyped(Promise.resolve(3));
  const assigned = {};
  Object.defineProperty(getters, "a", { enumerable: true, get() { return 1; } });
  Object.defineProperty(getters, "b", { enumerable: true, get() { return assigned.a; } });
  Object.assign(assigned, getters);
  console.log(assigned.a, assigned.b);
  console.log(JSON.stringify(getters, null, 1), JSON.stringify(getters, (key, value) => (key === "a" ? 2 : value)));

  const plain = untyped(Promise.resolve(0));
  console.log(Object.isExtensible(plain), Object.isSealed(plain), Object.isFrozen(plain), JSON.stringify(plain));
  const sealed = untyped(Promise.resolve(1));
  sealed.mark = 1;
  Object.seal(sealed);
  sealed.mark = 2;
  try {
    delete sealed.mark;
  } catch (e) {
    console.log(e.constructor.name, e.message);
  }
  console.log(Object.isSealed(sealed), Object.isFrozen(sealed), sealed.mark, Object.isExtensible(sealed));
  const closed = untyped(Promise.resolve(2));
  Object.preventExtensions(closed);
  try {
    closed.added = 1;
  } catch (e) {
    console.log(e.constructor.name, e.message);
  }
  console.log(Object.isExtensible(closed), Object.isSealed(closed), "added" in closed);
  Object.freeze(later);
  console.log(Object.isFrozen(later), Object.isExtensible(later));
  try {
    later.status = "changed";
  } catch (e) {
    console.log(e.constructor.name, e.message);
  }
  try {
    later.extra = 1;
  } catch (e) {
    console.log(e.constructor.name, e.message);
  }
  later.then((value) => console.log("still a promise", value));
}, 20);

// A definition's key converts once, to the name it defines.
setTimeout(() => {
  const defined = untyped(Promise.resolve(4));
  let conversions = 0;
  const key = {
    toString() {
      conversions++;
      return conversions === 1 ? "safe" : "then";
    },
  };
  Object.defineProperty(defined, key, { value: 42, enumerable: true });
  console.log(conversions, defined.safe, typeof defined.then, Object.keys(defined));
  defined.then((value) => console.log("still resolves", value));
}, 30);

// An own function named like an array method shadows the dispatch on the
// promise, getter included, and reads `this`; a non-function one is not
// callable.
setTimeout(() => {
  const calls = untyped(Promise.resolve(3));
  calls.tag = "calls";
  calls.map = function (n) {
    return this.tag === "calls" ? n * 2 : "lost this";
  };
  // The method is read before its arguments evaluate.
  Object.defineProperty(calls, "filter", {
    get: () => {
      console.log("read filter");
      return (label) => `from a getter, ${label}`;
    },
  });
  calls.join = 5;
  console.log(calls.map(21), calls.filter((console.log("argument"), "late")));
  try {
    calls.join(",");
  } catch (e) {
    console.log(e.constructor.name, e.message);
  }
}, 40);
