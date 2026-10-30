// Maybe-promise unions (`T | Promise<T>`) compile when the union tag can
// answer what JS's await decides. These forms stay refused.

// A data arm that declares `then` is a thenable: await would adopt it.
interface Thenish {
  then(cb: (v: number) => void): void;
}
function thenable(): Thenish | Promise<number> {
  return Promise.resolve(1);
}
console.log(typeof thenable);

// Promise arms merge into one promise of their payload union (`await` settles
// to either payload). They do not merge when a payload has no union arm home:
// a RegExp payload is the promise slot's own, not an arm.
function splitPromises(): Promise<RegExp> | Promise<string> | boolean {
  return true;
}
console.log(typeof splitPromises);

// Promises have no inspect lowering, so neither does a union holding one.
function maybe(b: boolean): string | Promise<string> {
  return b ? "s" : Promise.resolve("p");
}
console.log(maybe(true));

// Promise.resolve hands the promise arm back as is, so the result type
// must be that arm's own promise type.
const widened = Promise.resolve<string | number>(maybe(false));
console.log(typeof widened);
