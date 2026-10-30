// Web streams with fetch: a JavaScript ReadableStream as a Response or
// Request body, fetch's bodies and readers as instances of the classes,
// and instanceof through constructor values held in variables.
const encoder = new TextEncoder();
const RS = ReadableStream;
const Reader = ReadableStreamDefaultReader;
const settled = (p) => p.then((v) => `ok:${v}`, (e) => `${e.name}:${e.message}`);

const body = new ReadableStream({
  start(c) {
    c.enqueue(encoder.encode("he"));
    c.enqueue(encoder.encode("llo"));
    c.close();
  },
});
const response = new Response(body);
console.log("response", await response.text(), response.bodyUsed);

const fetched = new Response("abc");
console.log("fetch-body", fetched.body instanceof ReadableStream, fetched.body instanceof RS, fetched.body.getReader() instanceof Reader);

const own = new ReadableStream();
const ownReader = own.getReader();
console.log("variables", own instanceof RS, ownReader instanceof Reader, ownReader instanceof ReadableStreamDefaultReader, {} instanceof RS);
const isInstance = (value, C) => value instanceof C;
console.log("parameters", isInstance(own, ReadableStream), isInstance(fetched.body, RS), isInstance(ownReader, RS), isInstance(new Uint8Array(1), Uint8Array));

const locked = new ReadableStream();
locked.getReader();
try {
  new Response(locked);
  console.log("locked", "no error");
} catch (e) {
  console.log("locked", e.name, e.message);
}

const request = new Request("http://example.com/", {
  method: "POST",
  body: new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([104, 105]));
      c.close();
    },
  }),
  duplex: "half",
});
console.log("request", await request.text());

const strings = new Response(new ReadableStream({ start(c) { c.enqueue("str"); c.close(); } }));
console.log("non-bytes", await settled(strings.text()));

// Clones go through an untyped parameter: Response.clone and Request.clone
// run on checked-dynamic handles.
const cloneOf = (value) => value.clone();
const stringSource = () => new ReadableStream({ start(c) { c.enqueue("str"); c.close(); } });
const original = new Response(stringSource());
const clone = cloneOf(original);
console.log("clone", await settled(original.text()), await settled(clone.text()));
const cloneOfClone = cloneOf(cloneOf(new Response(stringSource())));
console.log("clone-of-clone", await settled(cloneOfClone.text()));
const requestClone = cloneOf(new Request("http://example.com/", { method: "POST", body: stringSource(), duplex: "half" }));
console.log("request-clone", await settled(requestClone.text()));
const bytesClone = cloneOf(new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode("ok")); c.close(); } })));
console.log("bytes-clone", await settled(bytesClone.text()));
