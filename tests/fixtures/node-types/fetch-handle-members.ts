// undici-types (@types/node's fetch declarations) spells the Headers methods
// and the Request/Response body mixin as function-typed properties; they
// must lower to the same native handle methods as the shipped declarations.
async function main(): Promise<void> {
  const h = new Headers([["b", "2"], ["a", "1"]]);
  h.append("set-cookie", "x=1");
  h.append("set-cookie", "y=2");
  h.set("c", "3");
  h.delete("b");
  const seen: string[] = [];
  h.forEach((value, name) => seen.push(`${name}=${value}`));
  console.log(seen.join(","), h.get("a"), h.has("b"), h.getSetCookie().join("|"));
  const r1 = new Response("body-text", { status: 202, statusText: "Acc", headers: h });
  console.log(r1.status, r1.statusText, r1.ok, r1.headers.get("c"), r1.bodyUsed);
  console.log(await r1.text(), r1.bodyUsed);
  const r2 = new Response(JSON.stringify({ k: 1 }));
  console.log(JSON.stringify(await r2.json()));
  const r3 = new Response(new Uint8Array([1, 2, 3]));
  console.log((await r3.arrayBuffer()).byteLength);
  const r4 = new Response("abc");
  console.log((await r4.bytes()).length);
  const r5 = Response.json({ z: true }, { status: 200 });
  console.log(r5.headers.get("content-type"), await r5.text());
  const req = new Request("http://x.test/a?b=1", { method: "POST", body: "payload", headers: { q: "1" } });
  console.log(req.method, req.url, req.headers.get("q"), await req.text());
  const req2 = new Request("http://x.test/j", { method: "PUT", body: "{\"n\":2}" });
  console.log(JSON.stringify(await req2.json()));
  const ac = new AbortController();
  ac.abort();
  console.log(ac.signal.aborted);
}
main();
