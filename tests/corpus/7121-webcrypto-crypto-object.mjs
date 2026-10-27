// The crypto global from JavaScript: uuid's feature test
// (`crypto.randomUUID && crypto.randomUUID()`), the methods read as values,
// and getRandomValues through the dynamic object, including its
// missing-argument and non-integer-view errors.
const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function v4(options) {
  if (!options && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "fallback";
}
console.log(shape.test(v4()), v4({}));
console.log(shape.test(globalThis.crypto.randomUUID()));
console.log(typeof crypto.randomUUID, typeof crypto.getRandomValues, typeof crypto.subtle);
console.log(crypto.randomUUID.name, crypto.getRandomValues.name, crypto.getRandomValues.length);

const native = typeof crypto !== "undefined" && crypto.randomUUID ? { randomUUID: crypto.randomUUID.bind(crypto) } : {};
console.log(shape.test(native.randomUUID()));

const rng = (n) => crypto.getRandomValues(new Uint8Array(n));
console.log(rng(16).length, rng(16) instanceof Uint8Array);
const words = new Uint32Array(4);
console.log(crypto.getRandomValues(words) === words);

function attempt(label, run) {
  try {
    console.log(label, run());
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}
attempt("no argument", () => crypto.getRandomValues());
attempt("float view", () => crypto.getRandomValues(new Float64Array(2)));
attempt("too long", () => crypto.getRandomValues(new Uint8Array(65537)));
