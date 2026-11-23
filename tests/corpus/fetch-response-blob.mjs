// Response.blob(): the body collected into a Blob whose type is the
// response's content type, lowercased and without spaces; absent reads "",
// and the body is consumed like every other reader.
const log = [];
const body = () => new Uint8Array([104, 105]);

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

const stringBlob = await new Response("hi").blob();
log.push(`string ${JSON.stringify(stringBlob.type)} ${stringBlob.size} ${await stringBlob.text()}`);

const jsonBlob = await Response.json({ a: 1 }).blob();
log.push(`json ${JSON.stringify(jsonBlob.type)} ${jsonBlob.size}`);

const nullBlob = await new Response(null).blob();
log.push(`null ${JSON.stringify(nullBlob.type)} ${nullBlob.size}`);

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
  headers: { "content-type": "Text/Plain" },
});
const requestBlob = await request.blob();
log.push(`request ${JSON.stringify(requestBlob.type)} ${requestBlob.size} ${await requestBlob.text()}`);

const arrayBuffer = await new Response(body()).blob().then((blob) => blob.arrayBuffer());
log.push(`buffer ${new TextDecoder().decode(arrayBuffer)}`);

for (const line of log) console.log(line);
