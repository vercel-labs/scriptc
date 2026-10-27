// AsyncLocalStorage contexts of stream events and callbacks, from
// JavaScript. Stream steps that Node defers with process.nextTick run in
// the context that scheduled them: resume() after a 'data' listener,
// uncork() from a tick, a write after end(), a push() from a user tick.
// Other events follow the call that emits them. stream.finished callbacks
// run in the context of their call, with stream/promises' finished()
// resolving in the context that awaits it. readline lines follow the
// createInterface() call that resumes the input, and zlib streams run
// their events and flush() callbacks in the context that created them.
import { AsyncLocalStorage } from "node:async_hooks";
import readline from "node:readline";
import { Duplex, finished, PassThrough, Readable, Writable } from "node:stream";
import { finished as finishedPromise } from "node:stream/promises";
import zlib from "node:zlib";

const store = new AsyncLocalStorage();
const lines = [];
const log = (what) => lines.push(`${what}: ${store.getStore() ?? "none"}`);
const step = (fn) => new Promise((resolve) => fn(resolve));

// pipe() and unpipe() events, and writes through a PassThrough.
await step((done) => {
  const through = new PassThrough();
  const sink = new Writable({ write(chunk, encoding, cb) { log("pipe write"); cb(); } });
  sink.on("pipe", () => log("pipe event"));
  sink.on("unpipe", () => log("unpipe event"));
  store.run("pipe", () => through.pipe(sink));
  store.run("through-write", () => through.write("q"));
  setTimeout(() => {
    store.run("unpipe", () => through.unpipe(sink));
    done();
  }, 5);
});

// cork() and uncork() from a tick: the writes follow the tick's context.
await step((done) => {
  const sink = new Writable({ write(chunk, encoding, cb) { log("corked write"); cb(); } });
  sink.on("finish", () => {
    log("corked finish");
    done();
  });
  store.run("cork", () => {
    sink.cork();
    sink.write("a");
    sink.write("b");
  });
  store.run("uncork", () => process.nextTick(() => sink.uncork()));
  setTimeout(() => store.run("corked-end", () => sink.end()), 5);
});

// A write after end(): its callback and 'error' follow the write() call.
await step((done) => {
  const sink = new Writable({ write(chunk, encoding, cb) { cb(); } });
  sink.on("error", () => log("write after end error"));
  sink.end();
  store.run("late-write", () =>
    sink.write("x", () => {
      log("late write callback");
      done();
    }),
  );
});

// A failing _write: the callback, 'error' and 'close' follow write().
await step((done) => {
  const sink = new Writable({ write(chunk, encoding, cb) { cb(new Error("bad")); } });
  sink.on("error", () => log("failed write error"));
  sink.on("close", () => {
    log("failed write close");
    done();
  });
  store.run("failed-write", () => sink.write("x", () => log("failed write callback")));
});

// A Duplex that pushes from _write: 'data' and 'end' follow the resume()
// tick, which the 'data' listener scheduled with no store.
await step((done) => {
  const duplex = new Duplex({
    read() {},
    write(chunk, encoding, cb) {
      log("duplex write");
      this.push(chunk);
      cb();
    },
  });
  duplex.on("data", () => {
    log("duplex data");
    duplex.push(null);
  });
  duplex.on("end", () => {
    log("duplex end");
    done();
  });
  store.run("duplex-write", () => duplex.write("z"));
});

// A push() from a user tick, a 'data' listener registered in a store with
// setEncoding(), and PassThrough's 'end' and 'close' after end().
await step((done) => {
  const source = new Readable({ read() {} });
  source.on("data", () => log("tick data"));
  source.on("end", () => {
    log("tick end");
    done();
  });
  store.run("user-tick", () =>
    process.nextTick(() => {
      log("user tick");
      source.push("x");
    }),
  );
  setTimeout(() => store.run("tick-eof", () => source.push(null)), 5);
});
await step((done) => {
  const source = new Readable({ read() {} });
  source.setEncoding("utf8");
  store.run("data-listener", () => source.on("data", () => log("text data")));
  source.on("end", () => {
    log("text end");
    done();
  });
  source.push("hi");
  source.push(null);
});
await step((done) => {
  const through = new PassThrough();
  through.on("end", () => log("through end"));
  through.on("close", () => {
    log("through close");
    done();
  });
  through.resume();
  store.run("through-end", () => through.end("last"));
});

// finished() on a Writable, and stream/promises' finished().
await step((done) => {
  const sink = new Writable({ write(chunk, encoding, cb) { setTimeout(cb, 1); } });
  store.run("finished-writable", () =>
    finished(sink, () => {
      log("finished callback");
      done();
    }),
  );
  sink.on("finish", () => log("writable finish"));
  store.run("writable-end", () => {
    sink.write("a");
    sink.end();
  });
});
await step((done) => {
  const source = new Readable({ read() {} });
  source.resume();
  store.run("finished-promise", () => finishedPromise(source)).then(() => {
    log("finished promise");
    done();
  });
  setTimeout(() => store.run("promise-eof", () => source.push(null)), 5);
});

// Readable.from() over an async generator: the reads follow the resume()
// tick, scheduled with no store.
await step((done) => {
  async function* letters() {
    log("generator start");
    yield "a";
    log("generator end");
  }
  const source = store.run("from", () => Readable.from(letters()));
  source.on("data", () => log("from data"));
  source.on("end", () => {
    log("from end");
    done();
  });
});

// readline over a Readable: createInterface() resumes the input.
await step((done) => {
  const input = Readable.from(["a\nb\n"]);
  const rl = store.run("readline", () => readline.createInterface({ input }));
  rl.on("line", (line) => log(`line ${line}`));
  rl.on("close", () => {
    log("readline close");
    done();
  });
});

// zlib streams: events and flush() callbacks follow the creation context.
await step((done) => {
  const gzip = store.run("gzip-create", () => zlib.createGzip());
  store.run("gzip-listen", () => {
    gzip.on("data", () => log("gzip data"));
    gzip.on("end", () => {
      log("gzip end");
      done();
    });
  });
  store.run("gzip-write", () => {
    gzip.write("hello");
    gzip.end();
  });
});
await step((done) => {
  const deflate = store.run("deflate-create", () => zlib.createDeflate());
  store.run("deflate-flush", () => deflate.flush(() => log("deflate flush callback")));
  deflate.on("data", () => {});
  deflate.on("end", () => {
    log("deflate end");
    done();
  });
  store.run("deflate-end", () => deflate.end("x"));
});

for (const line of lines) console.log(line);
