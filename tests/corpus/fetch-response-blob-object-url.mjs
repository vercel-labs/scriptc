// A Blob obtained through a runtime-computed body method is an ordinary
// Blob: URL.createObjectURL registers it and fetch() of that URL answers
// its bytes, its size as Content-Length and its type as Content-Type. The
// compiler cannot see the method's name here, so the object-URL fetch path
// must not depend on a compile-time blob fact.
const anyR = /** @type {any} */ (new Response("hi", { headers: { "content-type": "Text/Plain" } }));
const name = String.fromCharCode(98, 108, 111, 98);
const blob = await anyR[name]();

const url = URL.createObjectURL(blob);
const response = await fetch(url);
console.log(
  "object url",
  url.startsWith("blob:nodedata:"),
  response.status,
  JSON.stringify(response.headers.get("content-type")),
  JSON.stringify(response.headers.get("content-length")),
  await response.text(),
);

// Only GET reaches the registry, and a revoked or unknown id fetches nothing.
try {
  await fetch(url, { method: "POST" });
  console.log("post accepted");
} catch (error) {
  console.log("post", error.name, error.message);
}

URL.revokeObjectURL(url);
try {
  await fetch(url);
  console.log("revoked accepted");
} catch (error) {
  console.log("revoked", error.name, error.message);
}

try {
  await fetch("blob:nodedata:00000000-0000-4000-8000-000000000000");
  console.log("unknown accepted");
} catch (error) {
  console.log("unknown", error.name, error.message);
}

// A blob without a type answers an empty Content-Type.
const untyped = new Blob(["hi"]);
const untypedUrl = URL.createObjectURL(untyped);
const untypedResponse = await fetch(untypedUrl);
console.log(
  "untyped",
  untypedResponse.status,
  JSON.stringify(untypedResponse.headers.get("content-type")),
  JSON.stringify(untypedResponse.headers.get("content-length")),
);
URL.revokeObjectURL(untypedUrl);
