// A value that is not an Error, thrown by the source of Readable.from, by a
// stream operator's function or by a pipeline stage, is the stream's reason
// as it was thrown: the 'error' listener, the for await that reads the stream
// and the pipeline's callback are handed that value, once.
import { Readable, Writable, pipeline } from "node:stream";

type Fields = { [key: string]: unknown };
function hasFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null;
}

function describe(value: unknown): string {
  if (value instanceof AggregateError) return `an AggregateError of ${value.errors.length}`;
  if (value instanceof Error) return `an Error (${value.message})`;
  if (hasFields(value)) return `an object with ${Object.keys(value).join(" and ")}`;
  return `${typeof value} ${String(value)}`;
}

const reasons: [string, unknown][] = [
  ["number", 451],
  ["string", "oven door open"],
  ["true", true],
  ["object", { tray: 3, state: "burnt" }],
  ["error", new RangeError("too hot")],
];

function* trays(reason: unknown): Generator<string> {
  yield "tray 1";
  throw reason;
}

async function* loaves(reason: unknown): AsyncGenerator<string> {
  yield "loaf 1";
  throw reason;
}

// A listener sees the value a synchronous source threw.
function watchSync(kind: string, reason: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    const oven = Readable.from(trays(reason));
    oven.on("data", (tray: unknown) => console.log(`sync source, ${kind}: baked ${String(tray)}`));
    oven.on("error", (received: unknown) => {
      console.log(`sync source, ${kind}: the listener got ${describe(received)}, the thrown value: ${received === reason}`);
    });
    oven.on("close", () => resolve());
  });
}

// So does a listener on a stream over an asynchronous source.
function watchAsync(kind: string, reason: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    const oven = Readable.from(loaves(reason));
    oven.on("data", (loaf: unknown) => console.log(`async source, ${kind}: baked ${String(loaf)}`));
    oven.on("error", (received: unknown) => {
      console.log(`async source, ${kind}: the listener got ${describe(received)}, the thrown value: ${received === reason}`);
    });
    oven.on("close", () => resolve());
  });
}

// A for await over the stream throws the value, not two of it.
async function readAll(kind: string, reason: unknown): Promise<void> {
  try {
    for await (const loaf of Readable.from(loaves(reason))) console.log(`for await, ${kind}: baked ${String(loaf)}`);
    console.log(`for await, ${kind}: ended`);
  } catch (caught) {
    console.log(`for await, ${kind}: caught ${describe(caught)}, the thrown value: ${caught === reason}`);
  }
}

// An operator's function that throws ends the stream it returns with the
// value.
async function glaze(kind: string, reason: unknown): Promise<void> {
  const glazed = Readable.from(["bun 1", "bun 2", "bun 3"]).map((bun: string): string => {
    if (bun === "bun 2") throw reason;
    return `${bun}, glazed`;
  });
  try {
    for await (const bun of glazed) console.log(`operator, ${kind}: ${String(bun)}`);
    console.log(`operator, ${kind}: ended`);
  } catch (caught) {
    console.log(`operator, ${kind}: caught ${describe(caught)}, the thrown value: ${caught === reason}`);
  }
}

// A pipeline stage that throws ends the pipeline with the value.
function pack(kind: string, reason: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    const shelf = new Writable({
      write(_box: Uint8Array | string, _encoding: string, done: () => void): void {
        done();
      },
    });
    pipeline(
      Readable.from(["roll 1", "roll 2"]),
      async function* (rolls: AsyncIterable<unknown>): AsyncGenerator<string> {
        for await (const roll of rolls) {
          if (roll === "roll 2") throw reason;
          yield `${String(roll)}, boxed`;
        }
      },
      shelf,
      (failure: unknown) => {
        console.log(`pipeline stage, ${kind}: ended with ${describe(failure)}, the thrown value: ${failure === reason}`);
        resolve();
      },
    );
  });
}

async function main(): Promise<void> {
  for (const [kind, reason] of reasons) {
    await watchSync(kind, reason);
    await watchAsync(kind, reason);
    await readAll(kind, reason);
    await glaze(kind, reason);
    await pack(kind, reason);
  }
}

main().then(
  () => console.log("done"),
  (failure: unknown) => console.log(`failed: ${describe(failure)}`),
);
