// end(cb) ignores what its completion callback returns, and so must the
// compiled program: a saved helper that returns a reference-counted value
// (a Buffer, a fresh stream) has that result released, not dropped by the
// completion dispatch. The sanitized lane's RC audit reports a dropped
// owned result as a leak, so this program fails there if the callback keeps
// its non-void signature.
import { Readable, Writable } from "node:stream";

const log: string[] = [];

function savedZero(): Buffer {
  log.push("zero called");
  return Buffer.from("zero-result");
}

function savedErrorFirst(error?: Error | null): Buffer {
  log.push(`ecb called ${error === undefined ? "with error" : "without error"}`);
  return Buffer.from("ecb-result");
}

// A per-request stream handed back to nobody (the shape a completion helper
// closing over request state returns).
function savedStream(): Readable {
  log.push("stream called");
  return Readable.from(["payload"]);
}

function savedPlainObject(): { done: boolean } {
  log.push("object called");
  return { done: true };
}

function sink(): Writable {
  return new Writable({
    write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
      callback();
    },
  });
}

function step(run: (done: () => void) => void): Promise<void> {
  return new Promise((resolve) => run(resolve));
}

function main(): Promise<void> {
  return step((done) => {
    // Zero-parameter saved callback.
    const writable = sink();
    writable.on("close", () => {
      log.push("zero close");
      done();
    });
    writable.end(savedZero);
  })
    .then(() =>
      step((done) => {
        // A callback that takes the error parameter (the error-first adapter).
        const writable = sink();
        writable.on("close", () => {
          log.push("ecb close");
          done();
        });
        writable.end(Buffer.from("x"), savedErrorFirst);
      }),
    )
    .then(() =>
      step((done) => {
        // The result is a stream, which the completion dispatch never reads.
        const writable = sink();
        writable.on("close", () => {
          log.push("stream close");
          done();
        });
        writable.end(savedStream);
      }),
    )
    .then(() =>
      step((done) => {
        // The result is a record value.
        const writable = sink();
        writable.on("close", () => {
          log.push("object close");
          done();
        });
        writable.end(Buffer.from("y"), savedPlainObject);
      }),
    );
}

main().then(() => {
  console.log(log.join("\n"));
});
