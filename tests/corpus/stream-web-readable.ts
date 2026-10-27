// node:stream/web exports the web stream globals themselves: its
// ReadableStream is globalThis.ReadableStream, with the same behavior
// (identity is pinned by stream-web-require.cjs).
import { ReadableStream } from "node:stream/web";
import type { ReadableStreamDefaultController } from "node:stream/web";

const stream = new ReadableStream<string>({
  start(controller: ReadableStreamDefaultController<string>) {
    controller.enqueue("a");
    controller.enqueue("b");
    controller.close();
  },
});
const reader = stream.getReader();
(async () => {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    console.log("chunk", value);
  }
  for await (const n of ReadableStream.from([1, 2, 3])) console.log("from", n);
})();
