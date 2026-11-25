// What the Promise combinators still refuse, each by name. Promise.all and
// Promise.allSettled take an array of one promise type, an array literal or
// a tuple value of different entries (corpus 6482, 9371 to 9375); an
// argument that is not an array, an entry that is a thenable, and the empty
// Promise.allSettled literal are refused. Promise.any lowers over ONE
// promise type: its heterogeneous literal lands on the checker's tuple
// overload and fences with the shared-type hint.
function* pending(): Generator<Promise<number>> {
  yield new Promise<number>((resolve) => resolve(1));
}
async function settledOfGenerator(): Promise<void> {
  const results = await Promise.allSettled(pending());
  console.log(results.length);
}
async function settledOfNothing(): Promise<void> {
  const results = await Promise.allSettled([]);
  console.log(results.length);
}
async function allOfSet(waiting: Set<Promise<number>>): Promise<void> {
  console.log((await Promise.all(waiting)).length);
}
declare const thenable: { then(resolve: (value: number) => void): void };
async function allOfThenable(): Promise<void> {
  const [value, text] = await Promise.all([thenable, Promise.resolve("s")]);
  console.log(value, text);
}
async function anyOfLiteral(): Promise<void> {
  const first = await Promise.any([
    new Promise<string>((resolve) => resolve("s")),
    new Promise<number>((resolve) => resolve(1)),
  ]);
  console.log(first);
}
async function anyOfGenerator(): Promise<void> {
  console.log(await Promise.any(pending()));
}
settledOfGenerator();
settledOfNothing();
allOfSet(new Set());
allOfThenable();
anyOfLiteral();
anyOfGenerator();
