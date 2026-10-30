// AsyncLocalStorage contexts of stream events and callbacks. A stream
// step that Node defers with process.nextTick runs in the context of the
// code that scheduled it; other events run in the context of the call that
// emits them: push(), write(), end(), destroy() or pipe(). stream.finished
// and stream.pipeline callbacks run in the context of their call. fs read
// and write streams and zlib streams run their events in the context that
// created them, as Node's handles do.
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { finished, pipeline, Readable, Transform, Writable } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";
import * as zlib from "node:zlib";

const store = new AsyncLocalStorage<string>();
const lines: string[] = [];
const log = (what: string): void => {
  lines.push(`${what}: ${store.getStore() ?? "none"}`);
};
const step = (fn: (done: () => void) => void): Promise<void> =>
  new Promise<void>((resolve) => fn(resolve));

// pipe(): the destination's writes and 'finish' follow the pipe() call.
await step((done) => {
  const source = new Readable({ read(): void {} });
  const sink = new Writable({
    write(chunk: Buffer, encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
      log("pipe write");
      cb();
    },
  });
  sink.on("finish", () => {
    log("pipe finish");
    done();
  });
  store.run("pipe", () => source.pipe(sink));
  store.run("push", () => {
    source.push("a");
    source.push(null);
  });
});

// A Transform's steps follow write() and end(); 'end' follows end().
await step((done) => {
  const upper = new Transform({
    transform(chunk: Buffer, encoding: BufferEncoding, cb: (error?: Error | null, data?: string) => void): void {
      log("transform");
      cb(null, chunk.toString().toUpperCase());
    },
    flush(cb: (error?: Error | null, data?: string) => void): void {
      log("flush");
      cb(null, "!");
    },
  });
  upper.on("data", () => log("transform data"));
  upper.on("end", () => {
    log("transform end");
    done();
  });
  store.run("write", () => upper.write("a"));
  store.run("end", () => upper.end());
});

// A write that completes later: its callback, _final, 'prefinish', the
// end() callback, 'finish' and 'close' follow the write() call.
await step((done) => {
  const slow = new Writable({
    write(chunk: Buffer, encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
      log("slow write");
      setImmediate(cb);
    },
    final(cb: (error?: Error | null) => void): void {
      log("final");
      cb();
    },
  });
  slow.on("prefinish", () => log("prefinish"));
  slow.on("finish", () => log("finish"));
  slow.on("close", () => {
    log("close");
    done();
  });
  store.run("slow-write", () => slow.write("a", () => log("write callback")));
  store.run("slow-end", () => slow.end(() => log("end callback")));
});

// 'readable' and 'end' follow the push() that triggers them.
await step((done) => {
  const source = new Readable({ read(): void {} });
  source.on("readable", () => {
    log("readable");
    while (source.read() !== null) {}
  });
  source.on("end", () => {
    log("readable end");
    done();
  });
  store.run("push-x", () => source.push("x"));
  setTimeout(() => store.run("push-eof", () => source.push(null)), 5);
});

// destroy(): 'error' and 'close' follow the destroy() call.
await step((done) => {
  const source = new Readable({ read(): void {} });
  source.on("error", () => log("destroy error"));
  source.on("close", () => {
    log("destroy close");
    done();
  });
  store.run("destroy", () => source.destroy(new Error("stopped")));
});

// finished() and pipeline() callbacks follow their call, also when another
// context ends or destroys the stream.
await step((done) => {
  const source = new Readable({ read(): void {} });
  store.run("finished", () =>
    finished(source, () => {
      log("finished callback");
      done();
    }),
  );
  source.resume();
  store.run("finished-eof", () => source.push(null));
});
await step((done) => {
  const source = new Readable({ read(): void {} });
  const sink = new Writable({
    write(chunk: Buffer, encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
      cb();
    },
  });
  store.run("pipeline", () =>
    pipeline(source, sink, (err: NodeJS.ErrnoException | null) => {
      log(`pipeline callback ${err ? err.message : "ok"}`);
      done();
    }),
  );
  setTimeout(() => store.run("pipeline-destroy", () => source.destroy(new Error("boom"))), 5);
});

// stream/promises pipeline: the stages follow the call; after the await
// the caller's context is back.
await store.run("promise-pipeline", () =>
  pipelinePromise(
    Readable.from(["a"]),
    new Writable({
      write(chunk: Buffer, encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
        log("promise pipeline write");
        cb();
      },
    }),
  ),
);
log("after the promise pipeline");

// fs streams: the events follow the context that created the stream.
const file = path.join(os.tmpdir(), `scriptc-7383-${process.pid}.txt`);
await step((done) => {
  const out = store.run("fs-write-create", () => fs.createWriteStream(file));
  out.on("finish", () => log("fs finish"));
  out.on("close", () => {
    log("fs write close");
    done();
  });
  store.run("fs-write", () => out.write("hello", () => log("fs write callback")));
  store.run("fs-end", () => out.end());
});
await step((done) => {
  const input = store.run("fs-read-create", () => fs.createReadStream(file));
  store.run("fs-listen", () => {
    input.on("open", () => log("fs open"));
    input.on("data", () => log("fs data"));
    input.on("end", () => log("fs end"));
    input.on("close", () => {
      log("fs read close");
      done();
    });
  });
});
fs.unlinkSync(file);

// zlib streams: the events follow the context that created the stream.
await step((done) => {
  const gzip = store.run("gzip-create", () => zlib.createGzip());
  const gunzip = store.run("gunzip-create", () => zlib.createGunzip());
  const parts: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
      log("gunzip output");
      parts.push(chunk);
      cb();
    },
  });
  store.run("zlib-pipeline", () =>
    pipeline(Readable.from(["hello ", "world"]), gzip, gunzip, sink, () => {
      log(`zlib pipeline callback ${Buffer.concat(parts).toString()}`);
      done();
    }),
  );
});

for (const line of lines) console.log(line);
