// A process started without an IPC channel has no process.disconnect and no
// process.send: a call throws the TypeError of calling undefined, and an
// optional call answers undefined without evaluating anything.
const attempt = (label, go) => {
  try {
    console.log(label, go());
  } catch (error) {
    console.log(label, "threw", error instanceof TypeError, error.message);
  }
};
attempt("disconnect", () => process.disconnect());
attempt("disconnect?.", () => process.disconnect?.());
attempt("send", () => process.send({ a: 1 }));
attempt("send?.", () => process.send?.({ a: 1 }));
if (process.disconnect) console.log("has disconnect");
if (process.send) console.log("has send");
function leave() {
  process.disconnect();
  console.log("not reached");
}
try {
  leave();
} catch (error) {
  console.log("statement threw", error.message);
}
console.log("after");
