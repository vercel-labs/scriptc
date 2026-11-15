// A stream ended with a reason that is not an Error leaves the reason what it
// was: the caller's variable, a closure that captured it, and an equal value
// that never went near the stream all still hold the number, the string or
// the object, and the 'error' listener is handed that same value.
import { Readable, Writable } from "node:stream";

type Fields = { [key: string]: unknown };
function hasFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null;
}

function describe(value: unknown): string {
  if (value instanceof Error) return `an Error (${value.message})`;
  if (hasFields(value)) return `an object with ${Object.keys(value).join(" and ")}`;
  return `${typeof value} ${String(value)}`;
}

// destroy() declares an Error; any other reason goes through the method as
// the stream has it.
function shutDown(stream: unknown, reason: unknown): void {
  if (!hasFields(stream)) return;
  const destroy = stream.destroy;
  if (typeof destroy === "function") destroy.call(stream, reason);
}

function sensorLog(): Writable {
  return new Writable({
    write(_reading: Uint8Array | string, _encoding: string, done: () => void): void {
      done();
    },
  });
}

function sensorFeed(): Readable {
  return new Readable({ read(): void {} });
}

type Watch = (onError: (received: unknown) => void, onClose: () => void) => unknown;
const log: Watch = (onError, onClose) => sensorLog().on("error", onError).on("close", onClose);
const feed: Watch = (onError, onClose) => sensorFeed().on("error", onError).on("close", onClose);

function closeWith(label: string, watch: Watch, reason: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    const later = (): string => describe(reason);
    const stream = watch(
      (received: unknown) => {
        console.log(`${label}: the listener got ${describe(received)}, the same value: ${received === reason}`);
      },
      () => {
        console.log(`${label}: after close the reason is ${later()}`);
        resolve();
      },
    );
    console.log(`${label}: before, the reason is ${describe(reason)}`);
    shutDown(stream, reason);
    console.log(`${label}: after, the reason is ${describe(reason)}`);
  });
}

async function main(): Promise<void> {
  const frost = { bed: 4, reading: "frost" };
  await closeWith("log, number", log, 17);
  await closeWith("log, string", log, "valve stuck");
  await closeWith("log, object", log, frost);
  await closeWith("log, true", log, true);
  await closeWith("feed, number", feed, 17);
  await closeWith("feed, string", feed, "valve stuck");
  await closeWith("feed, object", feed, frost);
  await closeWith("log, a real error", log, new RangeError("too dry"));

  // A falsy reason is no reason: the stream closes and no 'error' follows.
  await closeWith("log, zero", log, 0);
  await closeWith("log, false", log, false);
  await closeWith("log, empty string", log, "");
  await closeWith("feed, zero", feed, 0);
  await closeWith("feed, false", feed, false);

  // Equal values that were never handed to a stream.
  const count: unknown = 17;
  const note: unknown = "valve stuck";
  const flag: unknown = true;
  console.log(`untouched: ${describe(count)}, ${describe(note)}, ${describe(flag)}`);
  console.log(`arithmetic still works: ${17 + (typeof count === "number" ? count : 0)}`);
  console.log(`the object kept its fields: ${frost.bed} ${frost.reading}, an Error: ${(frost as unknown) instanceof Error}`);
  console.log(`a clone of it: ${JSON.stringify(structuredClone(frost))}`);
}

main().then(
  () => console.log("done"),
  (failure: unknown) => console.log(`failed: ${describe(failure)}`),
);
