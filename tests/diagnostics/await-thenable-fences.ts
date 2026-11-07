// `await` calls the `then` of a typed thenable through the value's
// checked-dynamic form. A value whose form does not carry the method is
// refused rather than awaited as a plain value: an instance of a class that
// extends Array boxes as the array, and a function with a `then` property as
// the function.
class Lazy extends Array<number> {
  then(resolve: (value: string) => void): void {
    resolve(String(this.length));
  }
}

const callable = Object.assign((n: number): number => n + 1, {
  then(resolve: (value: string) => void): void {
    resolve("from a function");
  },
});

async function main(): Promise<void> {
  const lazy = new Lazy();
  await lazy;
  const text = await callable;
  console.log(text);
}
main();
