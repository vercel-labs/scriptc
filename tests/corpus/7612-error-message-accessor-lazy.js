// zod 4's lazy error message: an initializer defines a shared accessor
// descriptor over `message` on an instance whose class extends a runtime
// Error parent, and the message is computed on first read and cached.
function _getMessage() {
  const internals = this._zod;
  internals.message ?? (internals.message = JSON.stringify(internals.def));
  return internals.message;
}
function _setMessage(value) {
  this._zod.message = value;
}
const _messageDesc = { get: _getMessage, set: _setMessage, enumerable: true, configurable: true };
function initializer(inst, def) {
  Object.defineProperty(inst, "_zod", { value: { def }, enumerable: false });
  inst.name = "$ZodError";
  Object.defineProperty(inst, "message", _messageDesc);
}
function make(Parent, def) {
  class Definition extends Parent {}
  const inst = new Definition();
  initializer(inst, def);
  return inst;
}
const err = make(Error, [{ code: "too_small", path: ["a"] }]);
console.log(err._zod.message, err.message, err._zod.message === err.message);
console.log(String(err), Object.keys(err).join());
err.message = "replaced";
console.log(err.message, err._zod.message, `${err}`);
try {
  throw err;
} catch (caught) {
  console.log(caught === err, caught.message, caught instanceof Error);
}
const plain = new Error("start");
Object.defineProperty(plain, "message", { get() { return "computed"; }, configurable: true });
console.log(plain.message, String(plain));
