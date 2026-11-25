// Web-platform globals Node documents in its globals chapter: Response and
// Request bodies and metadata, the three stream classes with their default
// reader, writer and controllers, the global performance and crypto
// objects, queueMicrotask ordering against timers, the `global` alias,
// and DOMException.
const response = new Response("hi", { status: 201, headers: { "x-a": "1" } });
console.log(response.status, response.ok, response.headers.get("x-a"), await response.text());
const json = Response.json({ a: 1 });
console.log(json.status, json.headers.get("content-type"), JSON.stringify(await json.json()));
const missing = new Response(null, { status: 404, statusText: "Nope" });
console.log(missing.ok, missing.status, missing.statusText, await missing.text());

const request = new Request("http://x.test/a?b=1", {
  method: "POST",
  body: "payload",
  headers: { "content-type": "text/plain" },
});
console.log(request.method, request.url, request.headers.get("content-type"), await request.text());

// ReadableStream with its default controller and reader.
const readable = new ReadableStream<string>({
  start(controller) {
    controller.enqueue("a");
    controller.enqueue("b");
    controller.close();
  },
});
const reader = readable.getReader();
const chunks: string[] = [];
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value);
}
console.log(chunks.join(""));

// WritableStream with its default writer.
const sunk: string[] = [];
const writable = new WritableStream<string>({
  write(chunk) {
    sunk.push(chunk);
  },
});
const writer = writable.getWriter();
await writer.write("a");
await writer.write("b");
await writer.close();
console.log(sunk.join(""));

// TransformStream with its default controller, driven by pipeThrough.
const upper = new TransformStream<string, string>({
  transform(chunk, controller) {
    controller.enqueue(chunk.toUpperCase());
  },
});
const source = new ReadableStream<string>({
  start(controller) {
    controller.enqueue("ab");
    controller.enqueue("cd");
    controller.close();
  },
});
const piped: string[] = [];
for await (const value of source.pipeThrough(upper)) piped.push(value);
console.log(piped.join(""));

// DOMException carries a name, a message and the legacy code.
const abort = new DOMException("boom", "AbortError");
console.log(abort.name, abort.message, abort.code, abort instanceof Error, abort instanceof DOMException);
const plain = new DOMException("m");
console.log(plain.name, plain.code);

// The global performance object hands out PerformanceMark and
// PerformanceMeasure entries, and the global crypto object is a Crypto.
const mark = performance.mark("a");
const measure = performance.measure("m", "a");
console.log(mark.name, mark.entryType, typeof mark.startTime, mark.duration);
console.log(measure.name, measure.entryType, typeof measure.duration, measure.startTime === mark.startTime);
console.log(performance.getEntriesByType("mark").length, performance.getEntriesByName("m").length);
console.log(typeof performance.now(), performance.now() >= 0);
console.log(crypto.randomUUID().length, crypto.getRandomValues(new Uint8Array(4)).length);

// `global` is globalThis.
console.log(typeof global, global === globalThis, typeof global.setTimeout, typeof globalThis.process);

// A microtask runs after the current job and before any timer.
queueMicrotask(() => console.log("micro"));
setTimeout(() => console.log("timer"), 0);
console.log("sync");
