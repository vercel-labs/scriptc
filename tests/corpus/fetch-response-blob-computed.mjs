// A Blob reached through an extracted body-method value or a runtime-
// computed member name is a body like any other: its bytes are sent, and
// its type becomes the Content-Type when the headers do not set one. The
// compiler cannot see the method's name here, so the runtime's body
// handling carries it.
const mk = () => new Response("hi", { headers: { "content-type": "Text/Plain" } });
const name = String.fromCharCode(98, 108, 111, 98);

// Extracted: the member read as a value, then called on another response.
const anyExtracted = /** @type {any} */ (mk());
const read = anyExtracted[name];
const extracted = await read.call(anyExtracted);
const echoed = new Response(extracted);
console.log("extracted", JSON.stringify(echoed.headers.get("content-type")), await echoed.text());

// Called through the computed member.
const anyComputed = /** @type {any} */ (mk());
const computed = await anyComputed[name]();
const sent = new Request("http://x/", { method: "POST", body: computed });
console.log("computed", JSON.stringify(sent.headers.get("content-type")), await sent.text());

// Read and called later, then used as an untyped Response body.
const anyRead = /** @type {any} */ (mk());
const method = anyRead[name];
const computedRead = await method.call(anyRead);
const untyped = new Response(computedRead);
console.log("computed read", JSON.stringify(untyped.headers.get("content-type")), await untyped.text());
