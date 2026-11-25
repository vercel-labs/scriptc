// Readable.from and Duplex.from over an instance of a class whose
// [Symbol.asyncIterator]() or [Symbol.iterator]() answers a generator, where
// the instance comes back through an untyped member: the checker infers its
// class, and the value is held as a checked-dynamic one. The stream is built
// from the class's own method, called on the instance.
const { Readable, Duplex } = require("node:stream");

class Delegating {
  constructor(items) {
    this.items = items;
    this.opened = 0;
  }
  [Symbol.asyncIterator]() {
    this.opened++;
    return this.frames();
  }
  async *frames() {
    for (const item of this.items) yield Buffer.from(`<${item}>`);
  }
}

class AsyncFrames {
  constructor(items) {
    this.items = items;
  }
  async *[Symbol.asyncIterator]() {
    for (const item of this.items) {
      await null;
      yield `[${item}]`;
    }
  }
}

class SyncFrames {
  constructor(items) {
    this.items = items;
  }
  *[Symbol.iterator]() {
    for (const item of this.items) yield `(${item})`;
  }
}

class Inner {
  delegating(items) {
    return new Delegating(items);
  }
  asyncFrames(items) {
    return new AsyncFrames(items);
  }
  syncFrames(items) {
    return new SyncFrames(items);
  }
}

class Outer {
  constructor() {
    this.inner = new Inner();
    this.last = null;
  }
  encode(items) {
    this.last = this.inner.delegating(items);
    return Readable.from(this.last);
  }
  async run() {
    for await (const chunk of this.encode(["a", "b"])) {
      console.log("delegating", Buffer.isBuffer(chunk), chunk.toString());
    }
    console.log("opened", this.last.opened);
    for await (const chunk of Readable.from(this.inner.asyncFrames(["c", "d"]))) {
      console.log("async", chunk);
    }
    for await (const chunk of Readable.from(this.inner.syncFrames(["e", "f"]))) {
      console.log("sync", chunk);
    }
    for await (const chunk of Duplex.from(this.inner.delegating(["g"]))) {
      console.log("duplex", chunk.toString());
    }
    const sized = Readable.from(this.inner.syncFrames(["h", "i"]), {
      objectMode: true,
      highWaterMark: 1,
    });
    console.log("options", sized.readableObjectMode, sized.readableHighWaterMark);
    const seen = [];
    sized.on("data", (chunk) => seen.push(chunk));
    await new Promise((resolve) => sized.on("end", () => resolve(undefined)));
    console.log("data", seen.join(" "));
  }
}

new Outer().run().then(
  () => console.log("done"),
  (error) => console.log("failed", String(error)),
);
