// AsyncDisposableStack's interface: Node's receiver errors — a bad receiver
// answers a rejected promise from disposeAsync and a throw from the other
// methods — the member table's lengths and names, the prototype's members,
// and the class's reflection. Node.js prints the same.
const log = (...args) => console.log(...args);
const attempt = async (label, run) => {
  try {
    const answer = run();
    if (answer !== null && typeof answer === "object" && typeof answer.then === "function") {
      log(label, "promise");
      log(label, "settles as", await answer.then(() => "fulfilled", (error) => error.name + ": " + error.message));
    } else {
      log(label, answer);
    }
  } catch (error) {
    log(label, error.name + ": " + error.message);
  }
};

async function receivers() {
  const { use, adopt, defer, move, disposeAsync } = new AsyncDisposableStack();
  await attempt("disposeAsync on an object", () => disposeAsync.call({}));
  await attempt("disposeAsync on null", () => disposeAsync.call(null));
  await attempt("disposeAsync detached", () => disposeAsync());
  await attempt("use on a string", () => use.call("x", null));
  await attempt("adopt on null", () => adopt.call(null, 1, () => {}));
  await attempt("defer on undefined", () => defer.call(undefined, () => {}));
  await attempt("move on a number", () => move.call(7));
  const stack = new AsyncDisposableStack();
  await attempt("use number", () => stack.use(5));
  await attempt("use undefined", () => stack.use(undefined));
  await attempt("use getter that throws", () =>
    stack.use({
      get [Symbol.asyncDispose]() {
        throw new RangeError("getter");
      },
    }),
  );
  await attempt("adopt non-callable", () => stack.adopt(1, 2));
  await attempt("defer non-callable", () => stack.defer("nope"));
  const moved = stack.move();
  await attempt("use after move", () => moved.use(null));
  await attempt("move after move", () => stack.move());
  const disposed = new AsyncDisposableStack();
  await attempt("disposeAsync disposed", () => disposed.disposeAsync());
  await attempt("use after disposeAsync", () => disposed.use(null));
  await attempt("defer after disposeAsync", () => disposed.defer(() => {}));
  await attempt("move after disposeAsync", () => disposed.move());
  log("disposed getter:", disposed.disposed, stack.disposed);
}

function reflection() {
  const stack = new AsyncDisposableStack();
  log("lengths:", AsyncDisposableStack.length, stack.use.length, stack.adopt.length, stack.defer.length, stack.move.length, stack.disposeAsync.length);
  log("names:", AsyncDisposableStack.name, stack.use.name, stack.adopt.name, stack.defer.name, stack.move.name, stack.disposeAsync.name);
  const descriptor = Object.getOwnPropertyDescriptor(AsyncDisposableStack.prototype, "disposed");
  log("getter:", descriptor.get.name, descriptor.get.length, descriptor.enumerable, descriptor.configurable, descriptor.set);
  log("prototype members:", Reflect.ownKeys(AsyncDisposableStack.prototype).map(String).join(","));
  // The prototype's `constructor` and the global name are two fenced function
  // values of the intrinsic graph (`prototype/constructor.js` compares them),
  // so this program pins what each is rather than their identity.
  log("constructor:", typeof AsyncDisposableStack.prototype.constructor, AsyncDisposableStack.prototype.constructor.name, AsyncDisposableStack.prototype.constructor.length);
  log("asyncDispose identity:", AsyncDisposableStack.prototype[Symbol.asyncDispose] === AsyncDisposableStack.prototype.disposeAsync);
  log("member identity:", stack.use === AsyncDisposableStack.prototype.use, stack.disposeAsync === AsyncDisposableStack.prototype.disposeAsync, stack.disposed === false);
  log("no syncDispose:", AsyncDisposableStack.prototype[Symbol.dispose], Symbol.dispose in AsyncDisposableStack.prototype);
  log("toString:", Object.prototype.toString.call(stack), String(stack), `${stack}`, JSON.stringify(stack), stack);
  log("own:", Object.getOwnPropertySymbols(stack).length, Object.keys(stack).length);
  log("instanceof:", stack instanceof AsyncDisposableStack, {} instanceof AsyncDisposableStack, AsyncDisposableStack.prototype instanceof Object);
  log("still extensible:", Object.isFrozen(AsyncDisposableStack.prototype), Object.getPrototypeOf(AsyncDisposableStack.prototype) === Object.prototype);
}

async function main() {
  await receivers();
  reflection();
}
main();
