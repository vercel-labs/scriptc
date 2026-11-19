// A fetch handle's own properties may refer back to the handle, directly or
// through the objects and closures they hold. Node collects the cycle once
// nothing else holds it; the own-property table must not keep it alive. The
// sanitized lane's end-of-exit collection makes a leak of these values
// visible as an audit failure.
const describe = (e) => `${e.name}: ${e.message}`;

const direct = new Request("http://example.com/direct");
direct.context = { lane: direct };
console.log("direct", direct.context.lane === direct);

const throughClosure = new Response("body", { status: 201 });
throughClosure.context = { read: () => throughClosure.status };
console.log("closure", throughClosure.context.read() === 201);

const headers = new Headers({ "x-lane": "headers" });
headers.context = { headers, get: () => headers.get("x-lane") };
console.log("headers", headers.context.get());

try {
  const accessor = new Request("http://example.com/accessor");
  Object.defineProperty(accessor, "context", {
    get: () => accessor,
    enumerable: true,
    configurable: true,
  });
  console.log("accessor", accessor.context === accessor);
} catch (e) {
  console.log("accessor", describe(e));
}

// Completed requests: each carries a context that names it, and the loop
// drops every reference. A server doing this per request must not keep the
// contexts until it exits.
for (let i = 0; i < 5000; i++) {
  const request = new Request("http://example.com/" + i);
  request.context = { request, index: i };
  if (request.context.index !== i) throw new Error("index lost");
}
console.log("repeated", "done");
