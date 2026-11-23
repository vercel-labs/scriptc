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

log.push(`then ${later.join(",")}`);

for (const line of log) console.log(line);
