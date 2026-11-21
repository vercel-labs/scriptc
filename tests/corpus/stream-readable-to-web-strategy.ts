// Readable.toWeb({ strategy }): the queuing strategy Node passes to the
// ReadableStream constructor. Its highWaterMark and size drive the adapter
// stream's backpressure; a valid strategy keeps the same chunk sequence, and
// the stream constructor's own checks refuse the invalid ones.
import { Readable } from "node:stream";

const log: string[] = [];
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class ThrowingSize {
  get size(): (chunk: Uint8Array) => number {
    throw new Error("size boom");
  }
}

class ThrowingHighWaterMark {
  get highWaterMark(): number {
    throw new Error("hwm boom");
  }
}

function makeSource(tag: string): Readable {
  let n = 0;
  return new Readable({
    read() {
      n++;
      const current = n;
      void tag;
      setImmediate(() => {
        this.push(Buffer.from(`c${current}`));
        if (current === 4) this.push(null);
      });
    },
  });
}

async function main(): Promise<void> {
  {
    const reader = Readable.toWeb(makeSource("hwm2"), { strategy: { highWaterMark: 2 } }).getReader();
    const chunks: string[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(Buffer.from(chunk.value ?? new Uint8Array()).toString());
    }
    log.push(`hwm2 chunks ${chunks.join(",")}`);
  }
  {
    let sizes = 0;
    let lastLength = 0;
    const reader = Readable.toWeb(makeSource("size"), {
      strategy: {
        highWaterMark: 3,
        size: (chunk: Uint8Array): number => {
          sizes++;
          lastLength = chunk.byteLength;
          return 2;
        },
      },
    }).getReader();
    await wait(20);
    const before = sizes;
    const first = await reader.read();
    log.push(
      `size before ${before} length ${lastLength} first ${Buffer.from(first.value ?? new Uint8Array()).toString()}`,
    );
    await reader.cancel();
  }
  {
    const reader = Readable.toWeb(makeSource("hwm0"), { strategy: { highWaterMark: 0 } }).getReader();
    await wait(20);
    const first = await reader.read();
    const second = await reader.read();
    log.push(
      `hwm0 ${Buffer.from(first.value ?? new Uint8Array()).toString()},${Buffer.from(second.value ?? new Uint8Array()).toString()}`,
    );
    await reader.cancel();
  }
  {
    let calls = 0;
    const reader = Readable.toWeb(makeSource("bytes"), {
      strategy: {
        highWaterMark: 5,
        size: (chunk: Uint8Array): number => {
          calls++;
          return chunk.byteLength;
        },
      },
    }).getReader();
    await wait(20);
    const before = calls;
    const first = await reader.read();
    const second = await reader.read();
    log.push(
      `bytes before ${before} ${Buffer.from(first.value ?? new Uint8Array()).toString()},${Buffer.from(second.value ?? new Uint8Array()).toString()}`,
    );
    await reader.cancel();
  }
  {
    const empty = Readable.toWeb(makeSource("empty"), { strategy: {} }).getReader();
    await wait(20);
    const first = await empty.read();
    log.push(`empty ${Buffer.from(first.value ?? new Uint8Array()).toString()}`);
    await empty.cancel();
  }
  {
    const none = Readable.toWeb(makeSource("none"), { strategy: null }).getReader();
    await wait(20);
    const first = await none.read();
    log.push(`null ${Buffer.from(first.value ?? new Uint8Array()).toString()}`);
    await none.cancel();
  }
}

async function refusals(): Promise<void> {
  const cases: Array<[string, () => unknown]> = [
    ["number", () => Readable.toWeb(makeSource("n"), { strategy: 5 as never })],
    ["negative", () => Readable.toWeb(makeSource("n"), { strategy: { highWaterMark: -1 } })],
    ["size", () => Readable.toWeb(makeSource("n"), { strategy: { size: 5 as never } })],
    ["size getter", () => Readable.toWeb(makeSource("n"), { strategy: new ThrowingSize() })],
    ["hwm getter", () => Readable.toWeb(makeSource("n"), { strategy: new ThrowingHighWaterMark() })],
  ];
  for (const [label, attempt] of cases) {
    try {
      attempt();
      log.push(`refusal ${label} accepted`);
    } catch (error) {
      const typed = error as Error & { code?: string };
      log.push(`refusal ${label} ${typed.name} ${typed.code ?? ""} ${typed.message}`);
    }
  }
}

main()
  .then(refusals)
  .then(() => {
    for (const line of log) console.log(line);
  });
