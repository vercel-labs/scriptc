// A stream destroyed with a reason that is not an Error emits that value.
// Every listener of the program's whose parameter admits it is handed the
// value itself, also when the stream module's own listeners (finished,
// pipeline) are registered on the same stream, and those report the value
// to their callbacks.
import { PassThrough, Readable, Writable, finished, pipeline } from "node:stream";

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
function lower(stream: unknown, reason: unknown): void {
  if (!hasFields(stream)) return;
  const destroy = stream.destroy;
  if (typeof destroy === "function") destroy.call(stream, reason);
}

function gauge(): Writable {
  return new Writable({
    write(_level: Uint8Array | string, _encoding: string, done: () => void): void {
      done();
    },
  });
}

// Three listeners of the program's and finished() on one stream.
function manyListeners(label: string, reason: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    const tide = gauge();
    const same = (received: unknown): string => `${describe(received)}, the same value: ${received === reason}`;
    tide.once("error", (received: unknown) => console.log(`${label}: the once listener got ${same(received)}`));
    tide.on("error", (received: unknown) => console.log(`${label}: the listener got ${same(received)}`));
    tide.prependListener("error", (received: unknown) => console.log(`${label}: the first listener got ${same(received)}`));
    finished(tide, (received: unknown) => {
      console.log(`${label}: finished got ${same(received)}`);
      resolve();
    });
    lower(tide, reason);
  });
}

// A pipeline whose middle stream is destroyed with the value: the program's
// listener on that stream and the pipeline's callback both get it.
function throughPipeline(label: string, reason: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    const buoy = new Readable({ read(): void {} });
    const relay = new PassThrough();
    relay.on("error", (received: unknown) => {
      console.log(`${label}: the relay's listener got ${describe(received)}, the same value: ${received === reason}`);
    });
    pipeline(buoy, relay, gauge(), (received: unknown) => {
      console.log(`${label}: the pipeline ended with ${describe(received)}, the same value: ${received === reason}`);
      resolve();
    });
    lower(relay, reason);
  });
}

// A listener that declares an Error is handed the Errors a stream ends with.
function declaredError(label: string, reason: Error): Promise<void> {
  return new Promise<void>((resolve) => {
    const tide = gauge();
    tide.on("error", (received: Error) => {
      console.log(`${label}: the listener got ${received.name} "${received.message}", the same Error: ${received === reason}`);
    });
    tide.on("close", () => resolve());
    tide.destroy(reason);
  });
}

async function main(): Promise<void> {
  const flood = { level: 7, unit: "m" };
  await manyListeners("listeners, number", 12);
  await manyListeners("listeners, string", "sensor adrift");
  await manyListeners("listeners, object", flood);
  await manyListeners("listeners, true", true);
  await manyListeners("listeners, an Error", new RangeError("below datum"));
  await throughPipeline("pipeline, number", 12);
  await throughPipeline("pipeline, string", "sensor adrift");
  await throughPipeline("pipeline, object", flood);
  await declaredError("declared Error", new RangeError("below datum"));
}

main().then(
  () => console.log("done"),
  (failure: unknown) => console.log(`failed: ${describe(failure)}`),
);
