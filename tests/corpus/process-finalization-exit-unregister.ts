// @normalize-pid
// Unregistering the last pending finalizer from inside the 'exit' drain
// takes the runtime's own 'exit' listener out of the list while the
// emitter walks it. Node's emitter clones the list per emission, so the
// program's listeners after it still run, in their registered order: the
// finalizer callback fires first (it was registered first), then the user
// 'exit' listener.
const ref = { name: "only" };
process.finalization.register(ref, (obj, event) => {
  console.log("fin", event, obj === ref);
  // The last pending pair goes away here, inside the exit emission.
  process.finalization.unregister(obj);
});
process.on("exit", (code) => console.log("user exit", code));
process.on("beforeExit", () => console.log("user beforeExit"));
console.log("registered");
