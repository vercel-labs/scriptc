// perf_hooks createSlidingWindowHistogram: the runtime keeps a fixed number
// of histogram chunks rotated by record count (recordsPerChunk) or wall time
// (chunkDuration, nanoseconds). snapshot() merges the chunks still inside the
// window into a Histogram over the same bucket layout.
import { createSlidingWindowHistogram } from "node:perf_hooks";

function show(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    const e = error as { name: string; code?: string; message: string };
    console.log(label, e.name, e.code ?? "", JSON.stringify(e.message));
  }
}

const counted = createSlidingWindowHistogram({ chunks: 3, recordsPerChunk: 2 });
for (const value of [1, 2, 3, 4, 5]) counted.record(value);
{
  const snapshot = counted.snapshot();
  console.log(
    "counted",
    snapshot.count,
    snapshot.min,
    snapshot.max,
    snapshot.mean,
    snapshot.percentile(50),
    snapshot.percentile(100),
  );
}

// Two more records fill generation 2 and start generation 3, which drops the
// first chunk (records 1 and 2) from the window.
counted.record(6);
counted.record(7);
{
  const snapshot = counted.snapshot();
  console.log("window", snapshot.count, snapshot.min, snapshot.max, snapshot.percentile(50));
}

// A snapshot is a separate histogram: more records do not change it.
const saved = counted.snapshot();
counted.record(8);
console.log("separate", saved.count, counted.snapshot().count);

counted.reset();
{
  const snapshot = counted.snapshot();
  console.log("reset", snapshot.count, snapshot.min, snapshot.max);
}

// BigInt records take the exact integer form.
const big = createSlidingWindowHistogram({ chunks: 2, recordsPerChunk: 1 });
big.record(5n);
big.record(9n);
{
  const snapshot = big.snapshot();
  console.log("big", snapshot.count, snapshot.min, snapshot.max);
}

// A custom layout quantizes the merged values like createHistogram's.
const custom = createSlidingWindowHistogram({
  chunks: 2,
  recordsPerChunk: 8,
  lowest: 10,
  highest: 100400,
  figures: 2,
});
for (let i = 0; i < 100; i++) custom.record(1000 + i * 10);
{
  const snapshot = custom.snapshot();
  console.log(
    "custom",
    snapshot.count,
    snapshot.min,
    snapshot.max,
    Number(snapshot.mean.toFixed(4)),
    snapshot.percentile(50),
    snapshot.percentile(100),
  );
}

// A time-rotated window: one minute per chunk, so both records stay inside.
const timed = createSlidingWindowHistogram({ chunks: 2, chunkDuration: 60_000 });
timed.record(10);
timed.record(20);
{
  const snapshot = timed.snapshot();
  console.log("timed", snapshot.count, snapshot.min, snapshot.max);
}

// BigInt records below 1, or outside the int64 range, throw Node's
// ERR_OUT_OF_RANGE and do not advance the window.
const guard = createSlidingWindowHistogram({ chunks: 2, recordsPerChunk: 2 });
guard.record(5);
guard.record(6);
for (const value of [0n, -1n, 2n ** 70n]) {
  show(`guard record ${value}`, () => guard.record(value));
}
console.log("guard count", guard.snapshot().count);

// chunkDuration is milliseconds. A burst of records with a little work
// between them stays in one 1 s chunk; read as nanoseconds, 1000 would be
// one microsecond and the burst would span several generations, so a
// single-chunk window would keep only the last.
const burst = createSlidingWindowHistogram({ chunks: 1, chunkDuration: 1000 });
let spin = 0;
for (const value of [1, 2, 3, 4, 5]) {
  for (let i = 0; i < 20000; i++) spin += i;
  burst.record(value);
}
console.log("burst", burst.snapshot().count, spin > 0);

// Options validation: Node's messages.
show("no options", () => createSlidingWindowHistogram(undefined as any));
show("chunks zero", () => createSlidingWindowHistogram({ chunks: 0, recordsPerChunk: 1 }));
show("chunks big", () => createSlidingWindowHistogram({ chunks: 1025, recordsPerChunk: 1 }));
show("chunks fraction", () => createSlidingWindowHistogram({ chunks: 1.5, recordsPerChunk: 1 }));
show("both modes", () =>
  createSlidingWindowHistogram({ chunks: 2, recordsPerChunk: 1, chunkDuration: 5 }),
);
show("no mode", () => createSlidingWindowHistogram({ chunks: 2 }));
show("duration zero", () => createSlidingWindowHistogram({ chunks: 2, chunkDuration: 0 }));
show("duration fraction", () =>
  createSlidingWindowHistogram({ chunks: 2, chunkDuration: 1.5 }),
);
show("records zero", () => createSlidingWindowHistogram({ chunks: 2, recordsPerChunk: 0 }));
show("records fraction", () =>
  createSlidingWindowHistogram({ chunks: 2, recordsPerChunk: 1.5 }),
);
show("figures", () =>
  createSlidingWindowHistogram({ chunks: 2, recordsPerChunk: 1, figures: 6 }),
);

// record validation matches the recordable histogram's.
for (const value of [0, -1, 1.5]) {
  show(`record ${value}`, () => counted.record(value));
}
