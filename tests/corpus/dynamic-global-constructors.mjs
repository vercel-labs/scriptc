// Constructors reached through the global object's computed key: the
// lowered builtin-value table answers a dyn.globalConstructor per name, and
// the dynamic tier's constructor hooks (installed when the program's facts
// reach the family) build the same values Node does.
const out = [];
const key = {};
for (const name of ["Date", "Map", "Set", "WeakMap", "WeakSet"]) {
  const C = globalThis[name];
  if (name === "Date") {
    out.push("Date " + new C(0).toISOString());
  } else if (name === "Map") {
    const map = new C([[1, 2]]);
    out.push("Map " + map.get(1) + " " + map.size);
  } else if (name === "Set") {
    const set = new C([3, 4]);
    out.push("Set " + set.has(4) + " " + set.size);
  } else if (name === "WeakMap") {
    const map = new C();
    map.set(key, 9);
    out.push("WeakMap " + map.get(key) + " " + map.has(key));
  } else {
    const set = new C();
    set.add(key);
    out.push("WeakSet " + set.has(key));
  }
}
const weakRef = new (globalThis["WeakRef"])(key);
out.push("WeakRef same " + (weakRef.deref() === key));
console.log(out.join("\n"));
