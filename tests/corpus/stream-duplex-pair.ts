// stream.duplexPair: two Duplexes wired to each other. A write is readable on
// the other side, the write callback completes when that side reads the
// chunk, end() ends the other side's readable and this side finishes after
// it, and destroying one side closes the other.
import { duplexPair } from "node:stream";

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
