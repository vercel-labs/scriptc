// A sloppy-mode program's writes onto a fetch class: a write that names a
// prototype accessor is ignored, as Node ignores it, while a write that names
// no member adds the own property and a method name shadows the method.
const describe = (e) => `${e.name}: ${e.message}`;

const req = new Request("http://example.com/sloppy", { method: "PUT" });
req.context = { lane: "sloppy" };
console.log("own", req.context.lane, Object.keys(req).join(","));
req.url = "http://other/";
req.bodyUsed = true;
req.headers = null;
console.log("ignored", req.method, req.url, req.bodyUsed, req.headers !== null);

const res = new Response("body", { status: 201 });
res.ok = false;
res.status = 500;
console.log("response ignored", res.status, res.ok, res.status > 0);

const headers = new Headers();
headers.zzz = 1;
console.log("headers own", headers.zzz, Object.keys(headers).join(","));

const copy = req.clone();
copy.context = { lane: "clone" };
console.log("clone own", copy.context.lane, copy.url === req.url);

try {
  const frozen = new Request("http://example.com/frozen");
  Object.preventExtensions(frozen);
  frozen.later = 1;
} catch (e) {
  console.log("non-extensible", describe(e));
}
