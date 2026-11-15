// An async function called through its name settles its promise with a
// missing element as `undefined`, whether it is an arrow bound to a const,
// a declaration, or a function declared inside another function, and
// whether the awaited value is compared directly or bound first.
const words = ["zero", "one", "two"];
const nth = async (index: number) => words[index];
console.log((await nth(7)) === undefined, await nth(1));
async function declared(index: number) {
  return words[index];
}
console.log((await declared(7)) === undefined, await declared(2));
const sync = (index: number) => words[index];
console.log(sync(7) === undefined, sync(0));

const bound = await nth(9);
console.log(bound === undefined, typeof bound);
async function main(): Promise<void> {
  const local = ["a"];
  const pick = async (index: number) => local[index];
  async function take(index: number) {
    return local[index];
  }
  console.log((await pick(3)) === undefined, (await take(3)) === undefined);
  console.log(await pick(0), await take(0));
  const later = await pick(8);
  console.log(later === undefined, String(later));
}
await main();
