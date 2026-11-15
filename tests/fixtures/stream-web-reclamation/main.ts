// The node -> web adapters of a compiled program must stop rooting the
// conversion once it reaches a terminal state: a service that adapts a
// stream per client operation would otherwise keep every node stream, its
// web controller and the event listeners alive until process exit. The loop
// builds five conversions per round, one per terminal path (readable
// completion, cancellation, readable error, writable close, writable
// abort), yields to the event loop so deferred stream ticks run, and reports
// the runtime heap growth after a warm-up. The completed adapter's listeners
// stay attached, as Node's do.
//
// The loop also makes two fromWeb calls per round whose signal option the
// factories reject, and four Duplex.toWeb calls per round whose readable
// options or readable stream the pair construction rejects: the exception
// reaches the caller, so the adapter each factory had begun to build is
// never returned, and it must not stay rooted either.
import { Duplex, Readable, Writable } from "node:stream";

function heapKb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024);
}

function readable(): Readable {
  return new Readable({
    read(): void {
      this.push("alpha");
      this.push("beta");
      this.push(null);
    },
  });
}

function failing(): Readable {
  return new Readable({
    read(): void {
      this.destroy(new Error("read failed"));
    },
  });
}

function sink(): Writable {
  return new Writable({
    write(_chunk: Buffer, _enc: string, cb: () => void): void {
      cb();
    },
  });
}

async function drain(web: ReadableStream): Promise<void> {
  const reader = web.getReader();
  for (;;) {
    const step = await reader.read();
    if (step.done) return;
  }
}

function turn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// A duplex both of whose sides are live: Duplex.toWeb builds the writable
// adapter first, then rejects the readable options.
function duplex(): Duplex {
  return new Duplex({
    read(): void {
      this.push(null);
    },
    write(_chunk: Buffer, _enc: string, cb: () => void): void {
      cb();
    },
  });
}

// A duplex whose readable side is already disabled: the pair's readable is
// built as an already-cancelled stream, so the constructor is what rejects.
function disabledDuplex(): Duplex {
  return new Duplex({
    readable: false,
    write(_chunk: Buffer, _enc: string, cb: () => void): void {
      cb();
    },
  });
}

// A signal option both factories reject. The thrown exception is the
// caller's; the adapter the factory had begun to build is never returned.
let rejectedCount = 0;
function rejected(): void {
  try {
    Writable.fromWeb(new WritableStream(), { signal: {} as AbortSignal });
  } catch {
    rejectedCount++;
  }
  try {
    Duplex.fromWeb(
      { readable: new ReadableStream(), writable: new WritableStream() },
      { signal: "x" as unknown as AbortSignal },
    );
  } catch {
    rejectedCount++;
  }
}

// A Duplex.toWeb pair construction that throws before the pair is complete.
// The writable adapter it built first never reaches the caller, so the
// caller cannot close it; it must be released here instead of staying
// rooted until exit.
let rejectedPairCount = 0;
function rejectedPair(): void {
  try {
    Duplex.toWeb(duplex(), { type: "text" as unknown as "bytes" });
  } catch {
    rejectedPairCount++;
  }
  try {
    Duplex.toWeb(duplex(), { readableType: "text" as unknown as "bytes" });
  } catch {
    rejectedPairCount++;
  }
  try {
    Duplex.toWeb(disabledDuplex(), { type: "text" as unknown as "bytes" });
  } catch {
    rejectedPairCount++;
  }
  try {
    Duplex.toWeb(disabledDuplex(), { readableType: "text" as unknown as "bytes" });
  } catch {
    rejectedPairCount++;
  }
}

async function main(): Promise<void> {
  const kept = readable();
  await drain(Readable.toWeb(kept));
  await turn();
  console.log("listeners", kept.listenerCount("data"), kept.listenerCount("error"));
  const keptSink = sink();
  const keptWriter = Writable.toWeb(keptSink).getWriter();
  await keptWriter.write("x");
  await keptWriter.close();
  await turn();
  console.log("listeners", keptSink.listenerCount("drain"), keptSink.listenerCount("error"));

  const rounds = 500;
  let baseline = 0;
  for (let i = 0; i < rounds; i++) {
    await drain(Readable.toWeb(readable()));
    await Readable.toWeb(readable()).cancel();
    try {
      await drain(Readable.toWeb(failing()));
    } catch {
      // the adapter reports the read error on the web side
    }
    const writer = Writable.toWeb(sink()).getWriter();
    await writer.write("x");
    await writer.close();
    await Writable.toWeb(sink()).getWriter().abort();
    rejected();
    rejectedPair();
    await turn();
    if (i === 100) baseline = heapKb();
  }
  console.log("growth", heapKb() - baseline);
  console.log("rejected", rejectedCount);
  console.log("rejectedPair", rejectedPairCount);
}

void main();
