// stream.duplexPair: two Duplexes wired to each other. A write is readable on
// the other side, the write callback completes when that side reads the
// chunk, end() ends the other side's readable and this side finishes after
// it, and destroying one side closes the other.
import { Duplex, duplexPair } from "node:stream";

const log: string[] = [];

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

async function main(): Promise<void> {
  {
    const [left, right] = duplexPair();
    log.push(`sides ${left.readable} ${left.writable} ${right.readable} ${right.writable}`);
    log.push(`halfOpen ${left.allowHalfOpen} ${right.allowHalfOpen}`);
    let completed = false;
    left.write("hello", () => {
      completed = true;
      log.push("write completed");
    });
    log.push(`before read ${completed} right length ${right.readableLength}`);
    const chunks: string[] = [];
    right.on("data", (data: Buffer) => chunks.push(String(data)));
    const ended = new Promise<void>((resolve) => right.once("end", resolve));
    await ticks(2);
    log.push(`read ${chunks.join("|")} completed ${completed}`);
    left.end();
    await ended;
    log.push(`right ended ${right.readableEnded}`);
  }

  {
    // An empty chunk completes on a later tick, not synchronously.
    const [left, right] = duplexPair();
    let completed = false;
    left.write("", () => {
      completed = true;
    });
    log.push(`empty sync ${completed}`);
    await ticks(2);
    log.push(`empty later ${completed} right length ${right.readableLength}`);
    left.destroy();
    await ticks(2);
  }

  {
    // end() finishes this side only after the other side's 'end'.
    const [left, right] = duplexPair();
    const updates: boolean[] = [];
    left.on("finish", () => updates.push(left.writableFinished));
    right.on("data", (data: Buffer) => log.push(`right data ${String(data)}`));
    const ended = new Promise<void>((resolve) => right.once("end", resolve));
    left.end("last");
    await ended;
    await ticks(2);
    log.push(`after end finish ${left.writableFinished} updates ${updates.join(",")}`);
  }

  {
    // Object mode passes the values through unchanged.
    const [left, right] = duplexPair({ objectMode: true });
    const got: unknown[] = [];
    right.on("data", (value: unknown) => got.push(value));
    const ended = new Promise<void>((resolve) => right.once("end", resolve));
    left.write({ n: 1 });
    left.write([1, 2]);
    left.end();
    await ended;
    log.push(`objects ${got.length} ${JSON.stringify(got)}`);
  }

  {
    // A dropped endpoint stays alive through the pair: the survivor still
    // receives the data written before the drop and the peer's 'end'.
    function survivor(): Duplex {
      const pair = duplexPair();
      pair[0].write("kept");
      pair[0].end();
      return pair[1];
    }
    const right = survivor();
    const chunks: string[] = [];
    right.on("data", (data: Buffer) => chunks.push(String(data)));
    await new Promise<void>((resolve) => right.once("end", resolve));
    log.push(`survivor ${chunks.join("|")}`);
  }

  {
    // An option callback is an own method that shadows the pair's hook, as
    // in Node: the custom write runs and the peer receives nothing.
    const writes: string[] = [];
    const [left, right] = duplexPair({
      write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
        writes.push(String(chunk));
        callback();
      },
    });
    const got: string[] = [];
    right.on("data", (data: Buffer) => got.push(String(data)));
    left.write("custom");
    left.end();
    await ticks(2);
    log.push(`custom write ${writes.join("|")} peer ${got.length}`);
  }

  {
    // Destroying one side closes the other without an error of its own.
    const [left, right] = duplexPair();
    const closes: string[] = [];
    left.on("close", () => closes.push("left"));
    right.on("close", () => closes.push("right"));
    left.on("error", (error: Error) => log.push(`left error ${error.message}`));
    left.destroy(new Error("boom"));
    await ticks(3);
    log.push(`closes ${closes.join(",")} right errored ${right.errored === null}`);
  }
}

await main();
console.log(log.join("\n"));
