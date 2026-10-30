// util.promisify over untyped functions in TypeScript: values typed `any`
// and functions whose parameters are `any` promisify at run time, and
// their promises settle with the callback's value (not the type of a
// builtin target's promisified form).
import { promisify } from "node:util";

const loose: any = (value: number, callback: (error: Error | null, result?: number) => void) =>
  callback(null, value + 1);
const looseAsync = promisify(loose);

function legacy(a: any, b: any, callback: any): void {
  setImmediate(() => (b === 0 ? callback(new RangeError("divide by zero")) : callback(null, a / b)));
}
const divide = promisify(legacy);

const handlers: Record<string, any> = {
  echo: (text: string, callback: (error: null, value: string) => void) => callback(null, text),
  later: (callback: (error: null, value: string[]) => void) =>
    setTimeout(() => callback(null, ["a", "b"]), 1),
};

async function main(): Promise<void> {
  console.log("loose:", await looseAsync(1));
  looseAsync(2).then((value: unknown) => console.log("then:", value));
  console.log("divide:", await divide(10, 4));
  try {
    await divide(1, 0);
  } catch (error) {
    console.log("rejected:", (error as Error).message);
  }
  for (const name of ["echo", "later"]) {
    const fn = promisify(handlers[name]);
    console.log(`${name}:`, name === "echo" ? await fn("hi") : await fn());
  }
  console.log("name:", divide.name, "length:", divide.length);
}

main();
