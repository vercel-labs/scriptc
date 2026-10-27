// Headers entries/keys/values on an untyped Headers value: live iterators over the
// sorted list, with set-cookie values one by one, as hono's Context copies headers.
const holder = JSON.parse("{}");
holder.res = new Response("body", { headers: { "x-b": "2", "X-A": "1", "set-cookie": "s=1" } });
holder.res.headers.append("set-cookie", "t=2");
const headers = holder.res.headers;
for (const [k, v] of headers.entries()) console.log("entry", k, v);
console.log(JSON.stringify([...headers.keys()]), JSON.stringify([...headers.values()]));
const it = headers.entries();
console.log(JSON.stringify(it.next()));
headers.append("a-first", "0");
headers.append("z-last", "9");
console.log(JSON.stringify(it.next()), JSON.stringify(it.next()));
const rest = [];
for (const entry of it) rest.push(entry.join("="));
console.log(rest.join(" "), JSON.stringify(it.next()));
const copy = JSON.parse("{}");
copy.res = new Response(null, { status: 204 });
for (const [k, v] of headers.entries()) {
  if (k === "set-cookie") continue;
  copy.res.headers.set(k, v);
}
console.log(JSON.stringify([...copy.res.headers.entries()]));
