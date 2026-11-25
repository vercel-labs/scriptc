// A class field first assigned inside a constructor branch: undefined until
// the branch runs, then the Map itself. The field is read and written
// through its methods, so the layout needs the undefined-armed union of the
// Map; a method call on the unassigned path throws Node's TypeError.
class Pending {
  constructor(opts) {
    if (opts.armed) this.entries = new Map();
  }
  add(key, value) {
    this.entries.set(key, value);
  }
  has(key) {
    return this.entries.has(key);
  }
  get(key) {
    return this.entries.get(key);
  }
  clear() {
    this.entries.clear();
  }
}

const armed = new Pending({ armed: true });
armed.add("a", 1);
armed.add("b", 2);
console.log(armed.has("a"), armed.has("c"), armed.get("b"));
armed.clear();
console.log(armed.has("a"));

const idle = new Pending({ armed: false });
console.log(idle.entries === undefined);
try {
  idle.add("x", 1);
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}

// The same shape for a Set field: `Set<T> | undefined` reads its methods
// through the same presence check.
class Seen {
  constructor(opts) {
    if (opts.armed) this.keys = new Set();
  }
  add(key) {
    this.keys.add(key);
  }
  has(key) {
    return this.keys.has(key);
  }
}

const seen = new Seen({ armed: true });
seen.add("x");
console.log(seen.has("x"), seen.has("y"), seen.keys === undefined);
const unseen = new Seen({ armed: false });
try {
  unseen.add("x");
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}
