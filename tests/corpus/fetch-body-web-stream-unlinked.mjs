// Fetch bodies as web ReadableStreams in a program that names none of the
// web stream classes: tee, values and for await on Response and Request
// bodies, and the body's lock and bodyUsed after them.
const decoder = new TextDecoder();
const settled = (p) => p.then((v) => `ok:${v}`, (e) => `${e.name}:${e.message}`);
const drain = async (stream) => {
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk);
  return out;
};

const response = new Response("two ways");
const [left, right] = response.body.tee();
console.log("tee", await drain(left), await drain(right), response.bodyUsed, response.body.locked);
console.log("used", await settled(response.text()));

const request = new Request("http://example.com/", { method: "PUT", body: "request body", duplex: "half" });
console.log("for await", await drain(request.body), request.bodyUsed);

const parts = [];
for await (const chunk of new Response("values()").body.values({ preventCancel: true })) parts.push(chunk.length);
console.log("values", parts.join(","));

const plain = new Response("plain");
console.log("plain", plain.body.locked, await plain.text(), plain.bodyUsed);
