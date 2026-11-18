// @normalize-pid
const a = { name: "a" };
const b = { name: "b" };
const c = { name: "c" };

process.on("beforeExit", () => console.log("user beforeExit"));

process.finalization.register(a, (ref, event) => {
  console.log(`exit ${ref === a} ${event}`);
});
process.finalization.registerBeforeExit(b, (ref, event) => {
  console.log(`beforeExit ${ref === b} ${event}`);
});

console.log("registered");
console.log(typeof process.finalization, process.finalization === process.finalization);
console.log(process.finalization.unregister(c));
process.on("exit", () => console.log("user exit"));
