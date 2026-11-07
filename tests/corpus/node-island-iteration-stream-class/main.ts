// @requires-libnode
// for await over an island object whose class has only Symbol.asyncIterator
// (an event stream of a client library): the loop drives the island's async
// protocol one step per iteration, so each event arrives before the next is
// produced, and break, return and a throw call the iterator's return().
import { consume, open, openLater, Stream } from "stream-pkg";

async function firstIndexOver(limit: number): Promise<number> {
  const stream = open(100, 1);
  for await (const event of stream) {
    if (event.index > limit) return event.index;
  }
  return -1;
}

async function* ticks(limit: number): AsyncGenerator<number, void, undefined> {
  try {
    for (let i = 0; i < limit; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      console.log(`native produces ${i}`);
      yield i;
    }
  } finally {
    console.log("native generator finally");
  }
}

async function main(): Promise<void> {
  const stream = await openLater(3, 2);
  for await (const event of stream) console.log(`native got ${event.type} ${event.index}`);
  console.log(`produced ${stream.produced} returned ${stream.returned}`);

  console.log("-- break");
  const endless = open(1000, 1);
  for await (const event of endless) {
    console.log(`native got ${event.index}`);
    if (event.index === 1) break;
  }
  console.log(`produced ${endless.produced} returned ${endless.returned}`);

  console.log("-- return");
  console.log(`first over 1: ${await firstIndexOver(1)}`);

  console.log("-- throw");
  const failing = new Stream(1000, 1);
  try {
    for await (const event of failing) {
      if (event.index === 1) throw new Error("native body threw");
    }
  } catch (e) {
    console.log(`caught ${(e as Error).message}`);
  }
  console.log(`produced ${failing.produced} returned ${failing.returned}`);

  console.log("-- the island consumes the program's stream");
  console.log(`island took ${await consume(ticks(1000), 2)}`);
  console.log("end");
}

main();
