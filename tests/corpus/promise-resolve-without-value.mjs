// Untyped JavaScript executors that settle with no value: Node's `resolve`
// takes its value optionally, so a call with none resolves the promise with
// undefined. The checker asks for a JSDoc hint before it will type such a
// `resolve`; the call is ordinary JavaScript and the lowering keeps it.

const closed = new Promise((resolve) => {
  setTimeout(() => resolve(), 1);
});
const value = await closed;
console.log("closed", value);

// the same shape behind a function, the way a close() method returns a
// promise that carries no result
function close() {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 1);
  });
}

await close();
console.log("after close");

// both settlements in one executor: the later call wins
const either = (settleWithValue) =>
  new Promise((resolve) => {
    setTimeout(() => {
      if (settleWithValue) resolve(42);
      else resolve();
    }, 1);
  });

console.log("with value", await either(true));
console.log("without value", await either(false));

// then() observes the undefined settlement
await either(false).then((settled) => console.log("then", settled));
console.log("done");
