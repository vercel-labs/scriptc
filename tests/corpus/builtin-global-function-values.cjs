// Builtin global functions read as values hold Node's functions: parseInt and
// parseFloat are the Number statics' values, isNaN and isFinite convert with
// ToNumber, Symbol makes symbols and has its statics, and Atomics is a
// namespace object whose operations run.
function named(name) {
  return globalThis[name];
}

const values = { parseInt, parseFloat, isNaN, isFinite, Symbol, eval, escape, unescape, WeakRef };
for (const key of Object.keys(values)) {
  const value = values[key];
  console.log(key, typeof value, value.name, value.length, value === named(key));
}
console.log(parseInt === Number.parseInt, parseFloat === Number.parseFloat, isNaN === Number.isNaN);

const parse = named("parseInt");
const parseNumber = named("parseFloat");
const notANumber = named("isNaN");
const finite = named("isFinite");
console.log(parse("0x1f"), parse("12px", 10), parseNumber("3.5e2x"), parseNumber(" .5"));
console.log(notANumber("x"), notANumber(" 12 "), notANumber(undefined), finite("1e400"), finite(null));

const S = named("Symbol");
const made = S("a");
console.log(typeof made, made.description, S().description, S(12).description, String(made));
console.log(S.iterator === Symbol.iterator, S.asyncIterator === Symbol.asyncIterator, typeof S.toStringTag);
console.log(S.for("k") === Symbol.for("k"), S.keyFor(Symbol.for("k")), S.keyFor(made));
try {
  S.keyFor(1);
} catch (error) {
  console.log(error.name, error.message);
}
try {
  new S();
} catch (error) {
  console.log(error.name, error.message);
}
console.log(S.for.name, S.for.length, S.keyFor.name, "iterator" in S, "missing" in S);

const A = named("Atomics");
console.log(typeof A, Object.prototype.toString.call(A), Object.getOwnPropertyNames(A).join(","));
console.log(A.add.name, A.add.length, A.wait.length, A.compareExchange.length, typeof A.isLockFree);
const shared = new Int32Array(new SharedArrayBuffer(16));
console.log(A.store(shared, 0, 5), A.add(shared, 0, 2), A.load(shared, 0), A.sub(shared, 0, 1));
console.log(A.compareExchange(shared, 0, 6, 9), A.exchange(shared, 0, 3), A.or(shared, 0, 4), A.load(shared, 0));
console.log(A.wait(shared, 1, 7, 0), A.notify(shared, 1), A.notify(shared, 1, 1));

console.log(named("String").name, named("Number").name, named("encodeURIComponent").name);
console.log(named("require"), named("module"), named("exports"), named("__dirname"), named("__filename"));
console.log(globalThis.require, globalThis.__filename, "require" in globalThis);
