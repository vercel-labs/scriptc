// A yield whose operand can never produce a value — `yield Promise.reject(e)`
// here, whose awaited type is never — never suspends: Node evaluates the
// operand, the evaluation abandons the generator, and the consumer's next()
// promise rejects with the operand's own error object. The generator's yield
// channel is the `never` sentinel for the single-yield shape and a valued one
// (string) for the mixed shape; both must keep the rejection reason's
// identity, and the generator must close after it.
function log(...parts) {
  console.log(parts.map((p) => String(p)).join(" "));
}

const e1 = new Error("boom");

/** @returns {AsyncGenerator<never, void, unknown>} */
async function* single() {
  yield Promise.reject(e1);
}

/** @returns {AsyncGenerator<string, void, unknown>} */
async function* mixed() {
  yield Promise.reject(e1);
  yield "unreachable";
}

async function main() {
  await single()
    .next()
    .then(
      () => log("single resolved"),
      (e) => log("single rejected", e === e1, e.message),
    );
  const it = mixed();
  await it.next().then(
    () => log("mixed resolved"),
    (e) => log("mixed rejected", e === e1, e.message),
  );
  await it.next().then((r) => log("mixed closed", r.done, r.value));
  log("done");
}

main();
