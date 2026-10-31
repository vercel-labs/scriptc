// A WeakMap/WeakSet method read as a value in a JavaScript source is the
// interned prototype function: it applies the method to its own receiver and
// throws Node's brand-check TypeError for a foreign one.

const wm = new WeakMap();
const key = {};
wm.set(key, 41);

const ws = new WeakSet();
ws.add(key);

function report(label, fn) {
  try {
    console.log(label, "value=" + String(fn()));
  } catch (e) {
    console.log(label, e.name, e.constructor === TypeError);
  }
}

report("proto-foreign-array", () => WeakMap.prototype.has.call([], key));
report("instance-foreign-array", () => {
  const has = wm.has;
  return has.call([], key, 1);
});
report("instance-foreign-plain", () => wm.get.call({}, key));
report("instance-primitive-this", () => wm.set.call(false, key, 2));
report("weakset-foreign-plain", () => ws.add.call({}, key));
report("weakset-primitive-this", () => ws.has.call(undefined, key));

report("instance-valid-get", () => {
  const get = wm.get;
  return get.call(wm, key);
});
report("instance-valid-has", () => wm.has.call(wm, key));
report("weakset-valid-delete", () => ws.delete.call(ws, key));
report("proto-valid-has", () => WeakMap.prototype.has.call(wm, key));

function withReceiver() {
  console.log("receiver evaluated");
  return wm;
}
report("call-receiver-foreign", () => withReceiver().has.call({}, key));
report("value-type", () => typeof wm.has);

// A receiver typed with both collections reads the function the value it
// holds answers, and one that may be null or undefined throws the
// property-read TypeError from the read itself.
function pick(flag) {
  return flag ? new WeakMap() : new WeakSet();
}

const either = pick(true);

report("union-map-has", () => {
  const has = either.has;
  return has.call(either, key);
});
report("union-set-has", () => {
  const set = pick(false);
  return set.has.call(set, key);
});
report("union-map-add", () => typeof either.add);
report("union-set-add", () => {
  const set = pick(false);
  return typeof set.add;
});
report("union-set-get", () => typeof pick(false).get);
report("union-foreign-receiver", () => either.has.call([], key));

function maybeKeyed(flag) {
  return flag ? new WeakMap() : null;
}

const missing = maybeKeyed(false);

report("null-read", () => missing.has);
report("null-present", () => {
  const held = maybeKeyed(true);
  return typeof held.get;
});

function maybeAbsent(flag) {
  return flag ? new WeakSet() : undefined;
}

report("undefined-read", () => maybeAbsent(false).delete);
report("undefined-present", () => {
  const held = maybeAbsent(true);
  return typeof held.add;
});

console.log(
  "null-message",
  (() => {
    try {
      return String(missing.get);
    } catch (e) {
      return e.message;
    }
  })(),
);
console.log(
  "undefined-message",
  (() => {
    try {
      return String(maybeAbsent(false).add);
    } catch (e) {
      return e.message;
    }
  })(),
);
