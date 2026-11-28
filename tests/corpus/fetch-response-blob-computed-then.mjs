// A body read through a member name the compiler cannot see, consumed with
// `.then` rather than `await`: nothing else in the program links the
// dyn-async unit, so the Blob unit must be selected for the runtime
// Response dispatch that answers blob().
const name = String.fromCharCode(98, 108, 111, 98);
const mk = () => new Response("hi", { headers: { "content-type": "Text/Plain" } });
const show = (label, promise) =>
  promise.then(
    (b) => console.log(label, JSON.stringify(b.type), b.size),
    (e) => console.log(label, "rejected", e.message)
  );

const computed = /** @type {any} */ (mk());
show("computed then", computed[name]());

const extracted = /** @type {any} */ (mk());
const read = extracted[name];
show("extracted then", read.call(extracted));

const literal = /** @type {any} */ (mk());
const literalRead = literal["blob"];
show("literal then", literalRead.call(literal));

// Keep the loop alive long enough for the reactions to run, as an ordinary
// program with pending work would.
setTimeout(() => {}, 100);
