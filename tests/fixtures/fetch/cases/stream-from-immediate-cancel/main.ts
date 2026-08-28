// @dynamic
// ReadableStream.from() iterator acquisition, async chunk identity, immediate
// cancellation, and fetch's RequestInit getter census. Byte-exact against the
// pinned Node runtime through code executing inside the dynamic island.
import {
  inheritedRequestBodyMethodOverrides,
  immediateCancelIterable,
  requestInitConversionOrder,
  requestInitReadOrder,
  streamFromProtocolProbe,
} from "stream-from-cancel-probe";

await ReadableStream.from(immediateCancelIterable() as any).cancel("why");
console.log("immediate cancel done");
await streamFromProtocolProbe();
await requestInitReadOrder(`${process.argv[2]}/text`);
await requestInitConversionOrder(`${process.argv[2]}/text`);
await inheritedRequestBodyMethodOverrides(`${process.argv[2]}/text`);
