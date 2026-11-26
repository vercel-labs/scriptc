// Response.blob(): the body collected into a Blob whose type is the
// response's content type parsed and re-serialized as a MIME type; absent
// reads "", and the body is consumed like every other reader.
const log = [];
const body = () => new Uint8Array([104, 105]);

// The method read as a value off the handle answers the shared body-method
// entry: a function named blob of length 0 that collects when called.
const reader = /** @type {any} */ (new Response("hi"));
log.push(`member ${typeof reader.blob} ${reader.blob.length} ${reader.blob.name} ${reader.blob === reader.blob}`);
const memberBlob = await reader.blob.call(reader);
log.push(`member blob ${JSON.stringify(memberBlob.type)} ${memberBlob.size} ${await memberBlob.text()}`);

// The read's promise is an ordinary typed promise: a `.then` reaction runs
// on its own microtask, with no timer keeping the program alive.
const later = [];
new Response("hi").blob().then((b) => later.push(`${b.type} ${b.size}`));

for (const contentType of [null, "Text/Plain", "text/plain; charset=utf-8", "application/json"]) {
  const response = contentType
    ? new Response(body(), { headers: { "content-type": contentType } })
    : new Response(body());
  const blob = await response.blob();
  log.push(
    `blob ${JSON.stringify(contentType)} ${JSON.stringify(blob.type)} ${blob.size} ${blob instanceof Blob} ${await blob.text()}`,
  );
}

const headers = new Response(body(), { headers: new Headers({ "Content-Type": "Text/HTML" }) });
const headerBlob = await headers.blob();
log.push(`headers ${JSON.stringify(headerBlob.type)} ${headerBlob.size}`);

for (const contentType of [
  'multipart/form-data; boundary="a b"',
  'text/plain; charset = "utf-8"',
  "text/plain;  charset=utf-8",
  "text/plain; charset= utf-8",
  "text/plain; charset",
  "text/plain ; charset=utf-8",
  "text",
  "/plain",
  "text/plain;;x=1",
  'text/plain; x="a b" ; y=2',
  "text/plain; x=1; x=2",
  "text/plain; x=",
  'text/plain; x=""',
  "text/plain; x=a=b",
  'text/plain; x="a;b"; y=1',
  'text/plain; x="a\\"b"',
  'text/plain; x="a\\\\b"',
  "text/plain; x=`a`",
  'text/plain; x="a b',
  "text/plain; x=1",
  "text/plain; X=1",
  'text/plain; charset="UTF-8"; boundary=xyz',
  'text/plain; x="café"',
  "TEXT/PLAIN; CHARSET=UTF-8",
  "*/*",
  "*/*;x=1",
]) {
  const blob = await new Response(body(), { headers: { "content-type": contentType } }).blob();
  log.push(`type ${JSON.stringify(contentType)} ${JSON.stringify(blob.type)}`);
}

const appended = new Response(body());
appended.headers.append("content-type", "bad");
appended.headers.append("content-type", "text/plain");
log.push(`appended ${JSON.stringify((await appended.blob()).type)}`);

const twoValid = new Response(body());
twoValid.headers.append("content-type", "text/plain");
twoValid.headers.append("content-type", "text/html; charset=LATIN1");
log.push(`twoValid ${JSON.stringify((await twoValid.blob()).type)}`);

const starThenValid = new Response(body());
starThenValid.headers.append("content-type", "*/*");
starThenValid.headers.append("content-type", "text/html");
log.push(`starThenValid ${JSON.stringify((await starThenValid.blob()).type)}`);

const comma = new Response(body(), { headers: { "content-type": 'text/plain; x="a,b", text/html' } });
log.push(`comma ${JSON.stringify((await comma.blob()).type)}`);

const stringBlob = await new Response("hi").blob();
log.push(`string ${JSON.stringify(stringBlob.type)} ${stringBlob.size} ${await stringBlob.text()}`);

const jsonBlob = await Response.json({ a: 1 }).blob();
log.push(`json ${JSON.stringify(jsonBlob.type)} ${jsonBlob.size}`);

const nullBlob = await new Response(null).blob();
log.push(`null ${JSON.stringify(nullBlob.type)} ${nullBlob.size}`);

const typedNullBlob = await new Response(null, { headers: { "content-type": "Text/Plain; charset=utf-8" } }).blob();
log.push(`typedNull ${JSON.stringify(typedNullBlob.type)} ${typedNullBlob.size}`);

const single = new Response(body());
await single.blob();
log.push(`used ${single.bodyUsed} ${single.body === null}`);
try {
  await single.blob();
  log.push("second accepted");
} catch (error) {
  log.push(`second ${error.name} ${error.message}`);
}

const request = new Request("http://x/", {
  method: "POST",
  body: new Uint8Array([104, 105]),
  headers: { "content-type": 'Text/Plain; x="a b"' },
});
const requestBlob = await request.blob();
log.push(`request ${JSON.stringify(requestBlob.type)} ${requestBlob.size} ${await requestBlob.text()}`);

const arrayBuffer = await new Response(body()).blob().then((blob) => blob.arrayBuffer());
log.push(`buffer ${new TextDecoder().decode(arrayBuffer)}`);

// The type is the header's value when the read settles: a Content-Type set
// after the call applies to a body still being read, while a null body
// answers the value at the call.
{
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(stream, { headers: { "content-type": "text/plain" } });
  const pending = response.blob();
  response.headers.set("content-type", "text/html; charset=utf-8");
  controller.enqueue(new TextEncoder().encode("hi"));
  controller.close();
  const late = await pending;
  log.push(`late ${JSON.stringify(late.type)} ${late.size}`);
}

const nullTimed = new Response(null, { headers: { "content-type": "text/plain" } });
const nullPending = nullTimed.blob();
nullTimed.headers.set("content-type", "text/html");
log.push(`null timing ${JSON.stringify((await nullPending).type)}`);

// A repeated content-type value with the previous essence and no charset of
// its own inherits that value's charset.
{
  const inherited = new Response(body());
  inherited.headers.append("content-type", "text/plain; charset=utf-8");
  inherited.headers.append("content-type", "text/plain");
  log.push(`inherit appended ${JSON.stringify((await inherited.blob()).type)}`);

  const sameHeader = new Response(body(), {
    headers: { "content-type": "text/plain; charset=utf-8, text/plain; x=1" },
  });
  log.push(`inherit comma ${JSON.stringify((await sameHeader.blob()).type)}`);

  const chain = new Response(body(), {
    headers: { "content-type": "text/plain; charset=a, text/plain, text/plain; charset=b" },
  });
  log.push(`inherit chain ${JSON.stringify((await chain.blob()).type)}`);

  const empty = new Response(body(), { headers: { "content-type": 'text/plain; charset="", text/plain' } });
  log.push(`inherit empty ${JSON.stringify((await empty.blob()).type)}`);

  const changed = new Response(body(), { headers: { "content-type": "text/plain; charset=utf-8, text/html" } });
  log.push(`inherit changed ${JSON.stringify((await changed.blob()).type)}`);
}

// A Blob the read produced is a body itself: its bytes are sent, and its
// type becomes the Content-Type when the headers do not set one.
{
  const produced = await new Response("hi", { headers: { "content-type": "Text/Plain" } }).blob();
  const echoed = new Response(produced);
  log.push(`body ${JSON.stringify(echoed.headers.get("content-type"))} ${await echoed.text()}`);
  const sent = new Request("http://x/", { method: "POST", body: produced });
  log.push(`request body ${JSON.stringify(sent.headers.get("content-type"))} ${await sent.text()}`);
  const untyped = await new Response(body()).blob();
  const plainBody = new Response(untyped);
  log.push(`untyped body ${JSON.stringify(plainBody.headers.get("content-type"))} ${await plainBody.text()}`);
  const withHeader = new Response(produced, { headers: { "content-type": "text/html" } });
  log.push(`body header ${JSON.stringify(withHeader.headers.get("content-type"))} ${await withHeader.text()}`);
}

// A content type with many quoted parameters parses in allocations
// proportional to the header, not to the suffix behind each quote.
{
  const many = Array.from({ length: 20000 }, (_, i) => `p${i}="v${i}"`).join("; ");
  const heavy = await new Response(body(), {
    headers: { "content-type": `text/plain; ${many}` },
  }).blob();
  const type = heavy.type;
  log.push(
    `many ${type.length} ${type.startsWith("text/plain;p0=v0;p1=v1")} ${type.endsWith("p19999=v19999")} ${heavy.size}`,
  );
}

log.push(`then ${later.join(",")}`);

for (const line of log) console.log(line);
