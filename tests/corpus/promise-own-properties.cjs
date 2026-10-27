"use strict";
// A promise holds own properties as any object does: React's use() tracks
// a thenable's state in `status`, `value` and `reason` on the promise. The
// promises reach this code as untyped values, as thenables reach use().
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
  console.log(JSON.stringify({ ...later }), JSON.stringify(Object.assign({}, later)));

  delete later.value;
  console.log(Object.keys(later), later.value);

  Object.defineProperty(later, "hidden", { value: 1, enumerable: false });
  console.log(Object.keys(later), later.hidden, Object.getOwnPropertyNames(later));
  console.log(Object.getOwnPropertyDescriptor(later, "status"));

  const plain = untyped(Promise.resolve(0));
  console.log(Object.isExtensible(plain), Object.isSealed(plain), Object.isFrozen(plain), JSON.stringify(plain));
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
