// @requires-libnode
// `quietfence` compiles natively with a refusal in its top-level code
// (process.exit as a value), in a branch this program never takes. Such a package runs in
// a Node island when the build with the island compiles. This program
// replaces process.stdout.write, which a build with any island refuses, so
// the package stays native and the build says so (SC8023).
//
// The program's own code holds a class that implements the async-iteration
// protocol in an AsyncIterable slot. The first lowering pass refuses that at
// the program's top level and a later pass of the same round compiles it, so
// the round's verdict is that the program compiles. A decision taken from
// the first pass's declarations would see a failing program, make the
// package's island final, and fail the build on the stdout replacement.
import { kind } from "quietfence";

class Counter implements AsyncIterable<number> {
  async *[Symbol.asyncIterator](): AsyncIterator<number> {
    yield 1;
    yield 2;
  }
}
async function sum(source: AsyncIterable<number>): Promise<number> {
  let total = 0;
  for await (const n of source) total += n;
  return total;
}

const original = process.stdout.write;
const seen: number[] = [];
process.stdout.write = function (chunk: any): boolean {
  seen.push(String(chunk).length);
  return (original as (chunk: string) => boolean).call(process.stdout, String(chunk));
} as any;

sum(new Counter()).then((total) => {
  console.log("sum", total, kind());
  process.stdout.write = original;
  console.log("writes seen", seen.length);
});
