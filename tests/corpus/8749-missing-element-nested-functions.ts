// A missing array element passed to a typed parameter reaches the callee
// as `undefined`, wherever the callee is declared: at module level, inside
// another function, hoisted above its declaration, or used as a value.
const crates: string[] = ["a"];
const sizes: number[] = [1];

function describe(c: string): string {
  return c === undefined ? "none" : c;
}
console.log(describe(crates[3]), describe(crates[0]));

function main(): void {
  const local: string[] = ["b"];
  // Called above its declaration.
  console.log(label(local[4]), label(local[0]));
  function label(c: string): string {
    return c === undefined ? "none" : c;
  }
  function twice(v: number): number {
    return v * 2;
  }
  console.log(twice(sizes[4]), twice(sizes[0]));

  // An annotated result that is a missing element.
  function at(list: string[], i: number): string {
    return list[i];
  }
  const missing = at(local, 5);
  console.log(missing === undefined, at(local, 0));

  // Defaulted and rest parameters beside the widened one.
  function padded(c: string, pad = 2): string {
    return c === undefined ? "none" + pad : c + pad;
  }
  function counted(c: string, ...rest: string[]): string {
    return (c === undefined ? "none" : c) + rest.length;
  }
  console.log(padded(local[3]), padded(local[0], 1), counted(local[9], "x"), counted(local[0]));

  // The same function as a callback and as a typed value.
  console.log(local.map(label).join(","));
  const typed: (c: string) => string = label;
  console.log(typed("z"));

  // One nested function calling another with the value it received.
  function outer(c: string): string {
    return inner(c) + "!";
  }
  function inner(c: string): string {
    return c === undefined ? "nothing" : c;
  }
  console.log(outer(local[7]), outer(local[0]));

  // A block-level declaration.
  if (local.length > 0) {
    function scoped(c: string): boolean {
      return c === undefined;
    }
    console.log(scoped(local[2]), scoped(local[0]));
  }

  // An in-bounds loop.
  let sum = 0;
  for (let i = 0; i < sizes.length; i++) sum += twice(sizes[i]);
  console.log(sum);
}
main();

async function later(): Promise<void> {
  const queue: string[] = ["q"];
  async function take(i: number): Promise<string> {
    return queue[i];
  }
  const got = await take(5);
  console.log(got === undefined, await take(0));
}
later().then(() => {
  // An error thrown by the callee, not by the call.
  function strict(c: string): number {
    return c.length;
  }
  try {
    console.log(strict(crates[0]));
    console.log(strict(crates[6]));
  } catch (e) {
    console.log(e instanceof TypeError, (e as Error).message);
  }
});
