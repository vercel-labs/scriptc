// Own properties on the fetch classes, as an untyped program adds them: a
// write that names no member of the class adds an own property, a name the
// class declares on its prototype keeps Node's rule (an accessor refuses the
// strict write, a method is shadowed by the own property), and the entry goes
// with the object it describes.
const describe = (e) => `${e.name}: ${e.message}`;

const req = new Request("http://example.com/path", { method: "POST", body: "b" });
req.context = { lane: "app" };
req.context.visits = 1;
console.log("request own", req.context.lane, req.context.visits);
console.log("has", "context" in req, Object.hasOwn(req, "context"), Object.keys(req).join(","));
req.text = "shadowed";
console.log("method shadowed", req.text, typeof req.text);
delete req.text;
console.log("after delete", "text" in req, Object.hasOwn(req, "text"), typeof req.text);
console.log("url kept", req.url);
try {
  req.url = "http://other/";
} catch (e) {
  console.log("strict url", describe(e));
}
console.log("url after strict", req.url);
Object.defineProperty(req, "url", { value: "defined", writable: true, enumerable: false, configurable: true });
console.log("defined url", req.url, Object.hasOwn(req, "url"), Object.keys(req).join(","));

const res = new Response("body", { status: 201, statusText: "Made" });
res.tag = 7;
console.log("response own", res.tag, res.status, res.statusText);
try {
  res.status = 500;
} catch (e) {
  console.log("strict status", describe(e));
}
console.log("status after strict", res.status);

const headers = new Headers({ "x-a": "1" });
headers.zzz = "own";
headers.append = "not a method";
// A method name the program shadows reads back through the own-property
// descriptor; reading the method itself as a value is a static-build
// limitation of its own (a native method has no function value).
const own = Object.getOwnPropertyDescriptor(headers, "append");
console.log("headers own", headers.zzz, own.value, headers.get("x-a"), Object.keys(headers).sort().join(","));

for (let i = 0; i < 1000; i++) {
  const one = new Request("http://example.com/" + i);
  one.index = i;
  if (one.index !== i) throw new Error("index lost");
}
console.log("repeated", "done");
