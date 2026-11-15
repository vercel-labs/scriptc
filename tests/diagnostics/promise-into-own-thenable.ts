// A promise given to one of the program's own types with a `then` method.
// The type is a record of its members: a class instance or an object literal
// becomes one with its identity, a promise does not (a record made from it
// would answer `instanceof Promise` and `===` for a copy). The refusal names
// the slot to declare instead.
interface Waitable {
  then(onFulfilled: (value: number) => void, onRejected: (reason: unknown) => void): void;
}

function watch(work: Waitable): void {
  work.then(
    (value) => console.log("value", value),
    (reason) => console.log("reason", String(reason)),
  );
}

watch(Promise.resolve(1));
