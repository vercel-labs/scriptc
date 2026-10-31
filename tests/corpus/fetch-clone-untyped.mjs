// Response.clone() and Request.clone() in JavaScript on values the checker
// types as Response and Request: the clone's metadata, headers and body
// branch, and Node's TypeErrors for a used body.
const describe = (e) => `${e.name}: ${e.message}`;

const original = new Response("from js", { status: 202, headers: { "x-c": "3" } });
const copy = original.clone();
console.log("meta", copy.status, copy.headers.get("x-c"), copy instanceof Response);
console.log("bodies", await original.text(), await copy.text());
try {
  copy.clone();
} catch (e) {
  console.log("used", describe(e));
}

const request = new Request("http://example.com/js", { method: "POST", body: "js body" });
const requestCopy = request.clone();
console.log("request", requestCopy.method, requestCopy.url, await requestCopy.text(), await request.text());
try {
  request.clone();
} catch (e) {
  console.log("request used", describe(e));
}

const viewed = new Response("viewed");
const [left] = viewed.clone().body.tee();
const reader = left.getReader();
console.log("tee of clone", new TextDecoder().decode((await reader.read()).value), await viewed.text());
