// util.inspect of function literals and declared functions names their
// constructor: AsyncFunction, GeneratorFunction, AsyncGeneratorFunction or
// Function.
import * as util from "node:util";

async function load(): Promise<number> {
  return 1;
}
function* count(): Generator<number> {
  yield 1;
}
async function* stream(): AsyncGenerator<number> {
  yield 1;
}
function plain(): number {
  return 1;
}
const arrow = async (): Promise<void> => {};
const named = async function fetchIt(): Promise<void> {};

console.log(util.inspect(load));
console.log(util.inspect(count));
console.log(util.inspect(stream));
console.log(util.inspect(plain));
console.log(util.inspect(arrow));
console.log(util.inspect(named));
console.log(util.inspect(async function () {}));
console.log(util.inspect(async () => {}));
console.log(util.inspect(function* () {}));
console.log(util.inspect(async function* () {}));
console.log(util.inspect(function () {}));
