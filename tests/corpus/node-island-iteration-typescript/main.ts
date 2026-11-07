// @requires-libnode
// The same crossings from TypeScript: an island's values are untyped there,
// and the program's generators are typed.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s: string): void => console.log(s);

function* squares(limit: number): Generator<number, string, undefined> {
  try {
    for (let i = 1; i <= limit; i++) yield i * i;
    return "done";
  } finally {
    log("squares finally");
  }
}
async function* words(limit: number): AsyncGenerator<string, void, undefined> {
  try {
    for (let i = 0; i < limit; i++) {
      await null;
      yield `word ${i}`;
    }
  } finally {
    log("words finally");
  }
}

async function main(): Promise<void> {
  for (const v of lib.count("loop", 4)) {
    log(`native got ${v}`);
    if (v === 1) break;
  }
  const [a, b] = lib.count("pattern", 5);
  log(`a=${a} b=${b}`);
  log(`spread ${[...lib.count("spread", 3)].join(",")}`);
  for await (const v of lib.later("async", 4)) {
    log(`native got ${v}`);
    if (v === "async 1") break;
  }
  log(`island took ${lib.take(squares(5), 2)}`);
  log(`island took ${await lib.takeAsync(words(5), 2)}`);
  log("end");
}

main();
