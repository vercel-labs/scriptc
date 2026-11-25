const headers = new Headers({ "x-test": "one" });
headers.append("x-test", "two");
const copied = new Headers(headers);
console.log(copied.get("x-test"), copied === headers);
const controller = new AbortController();
const request = new Request("http://localhost/path", {
  method: "POST", headers: copied, body: "hello", redirect: "manual", signal: controller.signal,
});
console.log(request.url, request.method, request.headers.get("x-test"), request.redirect);
console.log(request.destination, request.referrer, request.referrerPolicy, request.mode, request.credentials, request.cache, request.integrity);
console.log(request.keepalive, request.isReloadNavigation, request.isHistoryNavigation, request.duplex);
console.log(request.body !== null, request.bodyUsed, request.signal === controller.signal, request.signal.aborted);
controller.abort("stopped");
console.log(request.signal.aborted, request.signal.reason);
console.log(await request.text(), request.bodyUsed);
try { await request.text(); } catch (error) { console.log((error as Error).name); }
const json = new Request("http://localhost/json", { method: "POST", body: '{"value":42}' });
console.log(JSON.stringify(await json.json()));
const bytes = new Request("http://localhost/bytes", { method: "POST", body: new Uint8Array([65, 66]) });
console.log(JSON.stringify(Array.from(await bytes.bytes())));
const buffer = new Request("http://localhost/buffer", { method: "POST", body: "AB" });
console.log(JSON.stringify(Array.from(new Uint8Array(await buffer.arrayBuffer()))));
const cached = new Request("http://localhost/cache", {
  cache: "no-store",
  credentials: "include",
});
console.log(cached.cache, cached.credentials, cached.mode, cached.redirect);
const inherited = new Request(cached);
console.log(inherited.cache, inherited.credentials);
const overridden = new Request(cached, { cache: "reload" });
console.log(overridden.cache, overridden.credentials);
try {
  new Request("http://localhost/x", { cache: "bogus" as "default" });
} catch (error) {
  console.log((error as Error).message);
}
try {
  new Request("http://localhost/x", { credentials: "bogus" as "include" });
} catch (error) {
  console.log((error as Error).message);
}
try {
  new Request("http://localhost/x", { cache: "only-if-cached" });
} catch (error) {
  console.log((error as Error).message);
}
for (const method of ["GET", "HEAD"]) {
  try { new Request("http://localhost/invalid", { method, body: "no" }); }
  catch (error) { console.log((error as Error).name); }
}
