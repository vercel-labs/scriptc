// A `yield` expression used as a value in a generator with no
// return-type annotation is legal JavaScript: the generator's sent and
// returned values are untyped. TypeScript reports TS7057 ("implicitly
// results in an 'any' type") and refuses the program.
function* echo(start) {
  const sent = yield start;
  const more = yield sent + 1;
  return more;
}
const it = echo(1);
console.log(it.next().value, it.next(10).value, it.next(20).value, it.next().done);
function* inner() {
  yield 1;
  yield 2;
}
function* outer() {
  const collected = [yield* inner()];
  const length = yield collected.length;
  return length;
}
const nested = outer();
console.log(nested.next().value, nested.next().value, nested.next().value);
console.log(nested.next("done").value);
async function* stream(limit) {
  for (let i = 0; i < limit; i++) {
    yield i;
  }
  const tail = yield limit;
  return tail;
}
(async () => {
  const seen = [];
  for await (const value of stream(3)) seen.push(value);
  const streamed = stream(1);
  await streamed.next();
  await streamed.next();
  console.log(seen.join(","), (await streamed.next("end")).value);
})();
