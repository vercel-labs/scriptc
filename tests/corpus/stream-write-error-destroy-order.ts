// A synchronous write hook that fails before end(): Node counts the failed
// write until its onwriteError tick, so the destroy starts with that write
// error and the pending _final never runs. A Transform whose _transform
// fails the same way never reaches _flush, and error/close carry the
// transform error.
import { Transform, Writable } from "node:stream";

const log: string[] = [];

function describe(error: Error | null): string {
  return error === null ? "none" : error.message;
}

class Failing extends Writable {
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    callback(new Error("write " + chunk.toString()));
  }
  _final(callback: (error?: Error | null) => void): void {
    callback(new Error("final failed"));
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    log.push(`failing destroy ${describe(error)}`);
    callback();
  }
}

class Fails extends Transform {
  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null, data?: Buffer | string) => void,
  ): void {
    callback(new Error("transform " + chunk.toString()));
  }
  _flush(callback: (error?: Error | null, data?: Buffer | string) => void): void {
    callback(new Error("flush failed"));
  }
}

async function main(): Promise<void> {
  const failing = new Failing();
  const failingClosed = new Promise<void>((resolve) => {
    failing.on("error", (error: Error) => log.push(`failing error ${describe(error)}`));
    failing.on("close", () => {
      log.push(`failing close ${describe(failing.errored)}`);
      resolve();
    });
  });
  failing.write("x");
  failing.end();
  await failingClosed;

  const fails = new Fails();
  const failsClosed = new Promise<void>((resolve) => {
    fails.on("error", (error: Error) => log.push(`fails error ${describe(error)}`));
    fails.on("close", () => {
      log.push(`fails close ${describe(fails.errored)}`);
      resolve();
    });
  });
  fails.write("y");
  fails.end();
  await failsClosed;
}

await main();
console.log(log.join("\n"));
