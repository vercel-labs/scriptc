// Promise.allSettled and Promise.any lower over ONE promise type (any
// Promise<T>[] expression); their heterogeneous array literals land on
// the checker's tuple overload and fence with the shared-type hint, and
// non-array arguments fence on their shape. (Promise.all's tuple overload
// lowers: corpus 6482.)
async function settled(): Promise<void> {
  const results = await Promise.allSettled([
    new Promise<string>((resolve) => resolve("s")),
    new Promise<number>((resolve) => resolve(1)),
  ]);
  console.log(results.length);
}
function* pending(): Generator<Promise<number>> {
  yield new Promise<number>((resolve) => resolve(1));
}
async function anyOfGenerator(): Promise<void> {
  console.log(await Promise.any(pending()));
}
settled();
anyOfGenerator();
