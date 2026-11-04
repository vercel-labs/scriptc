// Each stack prototype's `disposed` getter reads the internal slot of its own
// stack kind, so a receiver of the other kind is the incompatible receiver.
// The two getters are distinct functions, and each answers its own stack's
// state. Node.js prints the same.
const attempt = (label, f) => {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, e.name + ": " + e.message);
  }
};
const read = (proto, receiver) => Reflect.get(proto, "disposed", receiver);
const syncGetter = Object.getOwnPropertyDescriptor(DisposableStack.prototype, "disposed").get;
const asyncGetter = Object.getOwnPropertyDescriptor(AsyncDisposableStack.prototype, "disposed").get;
const stack = new DisposableStack();
const asyncStack = new AsyncDisposableStack();
attempt("sync on sync", () => read(DisposableStack.prototype, stack));
attempt("sync on async", () => read(DisposableStack.prototype, asyncStack));
attempt("async on async", () => read(AsyncDisposableStack.prototype, asyncStack));
attempt("async on sync", () => read(AsyncDisposableStack.prototype, stack));
attempt("sync on object", () => read(DisposableStack.prototype, {}));
attempt("sync on null-prototype object", () => read(DisposableStack.prototype, Object.create(null)));
class Box {}
attempt("sync on class instance", () => read(DisposableStack.prototype, new Box()));
attempt("async on null", () => read(AsyncDisposableStack.prototype, null));
console.log(syncGetter === asyncGetter);
stack.dispose();
attempt("sync disposed after dispose", () => read(DisposableStack.prototype, stack));
attempt("sync getter on a disposed async stack", () => read(DisposableStack.prototype, asyncStack));
