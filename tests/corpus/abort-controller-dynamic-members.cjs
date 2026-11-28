// An AbortController reached through a checked-dynamic construction: its
// members are the class prototype's, so `typeof c.abort` is "function" with
// the method's name and length, the method value is one function across
// reads and instances, and calling it (plain, extracted with call, or bound)
// still aborts the controller it was read from.
const make = (Ctor) => new Ctor();

const controller = make(globalThis.AbortController);
console.log("typeof", typeof controller.abort, typeof controller.signal);
console.log("method shape", controller.abort.name, controller.abort.length);
console.log("identity", controller.abort === controller.abort);
console.log(
  "one function across instances",
  controller.abort === make(globalThis.AbortController).abort,
);
console.log("member", "abort" in controller, typeof controller["abort"]);

const extracted = controller.abort;
extracted.call(controller, "from-extracted");
console.log("aborted", controller.signal.aborted, controller.signal.reason);

const second = make(globalThis.AbortController);
const bound = second.abort.bind(second);
bound("from-bound");
console.log("aborted2", second.signal.aborted, second.signal.reason);
second.abort("again");
console.log("reason stays", second.signal.reason);
