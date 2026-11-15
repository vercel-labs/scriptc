// stream.duplexPair: two Duplexes joined back to back. A chunk written to one
// side becomes the other side's next chunk and the write completes only when
// that side is read, so a slow reader back-pressures the writer; an empty
// chunk completes on the next tick instead. Ending one side ends the peer's
// readable side, destroying one side closes the other, and the options are the
// Duplex constructor's (an option callback shadows the pair's own method).
import { Duplex, Readable, Writable, duplexPair } from "node:stream";

function show(label: string, f: () => void): void {
  try {
    f();
    console.log(label, "ok");
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    console.log(label, "->", error.name, error.code, JSON.stringify(error.message));
  }
}

const pair = duplexPair();
const a = pair[0];
const b = pair[1];
console.log("pair length", pair.length, pair[0] === a, pair[1] === b);
console.log("classes", a instanceof Duplex, a instanceof Readable, a instanceof Writable);
console.log("sides", a.readableObjectMode, a.writableObjectMode, b.readableObjectMode);
console.log(
  "hwm",
  a.readableHighWaterMark,
  a.writableHighWaterMark,
  a.readableLength,
  a.writableLength,
);
const [direct] = duplexPair();
console.log("destructured", direct instanceof Duplex);
console.log("independent", a !== b, direct !== a);

// One chunk each way: the write completes when the other side reads it.
const log: string[] = [];
a.write("from a", () => log.push("a1 done"));
log.push("after a1 write");
console.log("log", log.join("|"));
const chunk = b.read();
console.log("b read", chunk && chunk.toString());
console.log("log after read", log.join("|"));
b.write("from b", () => log.push("b1 done"));
const back = a.read();
console.log("a read", back && back.toString(), log.join("|"));

// A write over the peer's high-water mark is buffered; the peer's read
// releases one chunk and the pending write completes in that order.
const order: string[] = [];
a.write(Buffer.alloc(4), () => order.push("w1"));
a.write(Buffer.alloc(4), () => order.push("w2"));
a.write(Buffer.alloc(4), () => order.push("w3"));
const length = (v: unknown): string =>
  v === null || v === undefined ? String(v) : String((v as Buffer).length);
console.log("queued", a.writableLength, order.length);
console.log("read1", length(b.read()), order.join(","));
console.log("read2", length(b.read()), order.join(","));
console.log("read3", length(b.read()), order.join(","));
process.nextTick(() => console.log("late read", length(b.read()), order.join(",")));

// An empty chunk is pushed nowhere and completes on the next tick.
a.write(Buffer.alloc(0), () => order.push("empty"));
console.log("empty write", order.join(","), a.writableLength, b.readableLength);
process.nextTick(() => {
  console.log("empty tick", order.join(","), b.readableLength);

  // end(): the peer sees EOF, and only then does this side finish.
  const endA = duplexPair();
  const ea = endA[0];
  const eb = endA[1];
  const events: string[] = [];
  ea.on("finish", () => events.push("a finish"));
  eb.on("end", () => events.push("b end"));
  eb.on("data", (c: Buffer) => events.push("b data " + c.toString()));
  eb.on("close", () => events.push("b close"));
  ea.on("close", () => events.push("a close"));
  ea.write("last");
  ea.end();
  eb.on("end", () => console.log("after end", events.join("|"), ea.writableEnded, eb.readableEnded));
});

// Object mode carries values, including empty ones.
const objects = duplexPair({ objectMode: true });
const [oa, ob] = objects;
console.log("object modes", oa.readableObjectMode, oa.writableObjectMode);
oa.write({ id: 1 }, () => console.log("object write done"));
console.log("object read", JSON.stringify(ob.read()));
oa.write("", () => console.log("empty string done"));
oa.write([], () => console.log("empty array done"));
console.log("empty object reads", ob.read(), ob.read());
ob.push({ reply: true });
console.log("reply", JSON.stringify(oa.read()));

// The writable bound: the write that crosses the high-water mark answers
// false, and the drain waits for the peer.
const tiny = duplexPair({ highWaterMark: 1 });
console.log("tiny write", tiny[0].write("x"), tiny[0].writableHighWaterMark);
console.log("tiny pending", tiny[0].writableLength);
tiny[0].on("drain", () => console.log("drain"));
tiny[1].read();
console.log("tiny after read", tiny[0].writableLength);

// Options shadow the pair's own methods, as instance properties shadow
// DuplexSide's prototype.
const optioned = duplexPair({
  write(this: Duplex, chunk: Buffer, _enc: string, cb: () => void) {
    console.log("option write", chunk.toString());
    cb();
  },
});
console.log("optioned write", optioned[0].write("direct"));
console.log("optioned read", optioned[1].read());

// destroy(): the peer closes gracefully on the next tick.
const destroyed = duplexPair();
destroyed[0].destroy();
console.log("after destroy", destroyed[0].destroyed, destroyed[1].destroyed);
process.nextTick(() => {
  console.log("destroy tick", destroyed[0].destroyed, destroyed[1].destroyed);
  const errored = duplexPair();
  errored[0].on("error", (e: Error) => console.log("a error", e.message));
  errored[1].on("error", (e: Error) => console.log("b error", e.message));
  errored[1].destroy(new Error("boom"));
  console.log("errored", errored[1].destroyed, errored[0].destroyed);
  process.nextTick(() => {
    console.log("errored tick", errored[1].destroyed, errored[0].destroyed, errored[0].errored);

    // A write after end is not thrown from write(): the stream emits
    // ERR_STREAM_WRITE_AFTER_END on a tick, and the call answers false.
    const done = duplexPair();
    done[0].on("error", (e: NodeJS.ErrnoException) => console.log("late error", e.code));
    done[0].end();
    console.log("late write", done[0].write("late"));
    show("bad hwm", () => duplexPair({ highWaterMark: -1 }));
    show("bad encoding", () => duplexPair({ defaultEncoding: "not-an-encoding" }));
  });
});
