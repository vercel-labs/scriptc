// The same from JavaScript: a body from a JavaScript ReadableStream whose
// first chunk is queued before text() reads it.
const encoder = new TextEncoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const response = new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode("late ")); c.enqueue(encoder.encode("read")); c.close(); } }));
await tick();
console.log("text", await response.text(), response.bodyUsed);

let pulls = 0;
const pulled = new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(encoder.encode(String(pulls))); if (pulls === 4) c.close(); } }));
await tick();
console.log("pull", await pulled.text(), pulls);
