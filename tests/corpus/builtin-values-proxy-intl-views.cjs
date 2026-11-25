// SharedArrayBuffer, DataView, BigInt64Array, BigUint64Array, Proxy and Intl
// read as values hold Node's functions and namespace object.
function attempt(label, run) {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, error.name, error.message);
  }
}

const constructors = { SharedArrayBuffer, DataView, BigInt64Array, BigUint64Array, Proxy };
for (const key of Object.keys(constructors)) {
  const value = constructors[key];
  console.log(key, typeof value, value.name, value.length, value === globalThis[key]);
  attempt(`call ${key}`, () => value());
}
console.log(constructors);
console.log(String(DataView), Object.prototype.toString.call(constructors.Proxy));

const shared = new SharedArrayBuffer(8);
const view = new DataView(new ArrayBuffer(4));
const stored = { shared: SharedArrayBuffer, view: DataView, proxy: Proxy, big: BigInt64Array };
console.log(shared instanceof stored.shared, new ArrayBuffer(1) instanceof stored.shared);
console.log(view instanceof stored.view, new Uint8Array(4) instanceof stored.view);
console.log(view instanceof stored.big, JSON.parse("1") instanceof stored.proxy);
attempt("instanceof Proxy", () => ({}) instanceof stored.proxy);

const intl = Intl;
console.log(typeof intl, intl === globalThis.Intl, Object.keys(intl).length, "NumberFormat" in intl);
console.log(Object.getOwnPropertyNames(intl).join(","));
console.log(Object.prototype.toString.call(intl), intl[Symbol.toStringTag]);
console.log(typeof intl.DateTimeFormat, intl.Locale.length, intl.DisplayNames.length);
console.log(new Intl.NumberFormat("en-US").format(1234.5));
