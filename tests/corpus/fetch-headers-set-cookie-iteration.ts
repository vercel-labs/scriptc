// Headers iteration follows Fetch's "sort and combine": names in byte
// order with their combined values, except that every Set-Cookie value is
// visited on its own. get() still joins them; getSetCookie() lists them.
const h = new Headers();
h.append("set-cookie", "a=1; Path=/");
h.append("x-b", "1");
h.append("Set-Cookie", "b=2, c=3");
h.append("x-a", "1");
h.append("x-a", "2");
h.append("set-cookie", "d=4");
h.forEach((value, name) => console.log(`${name}: ${value}`));
console.log(JSON.stringify(h.get("set-cookie")));
console.log(JSON.stringify(h.getSetCookie()));

// A thisArg and the Headers object reach the callback.
const self = { tag: "this" };
h.forEach(function (this: typeof self, _value, name, headers) {
  if (name === "x-b") console.log(this.tag, headers === h);
}, self);

// Iteration is live and indexes the expanded list: deleting the cookies
// while visiting the first one shifts the next name into its slot.
const live = new Headers();
live.append("set-cookie", "a=1");
live.append("set-cookie", "b=2");
live.append("x-z", "z");
const seen: string[] = [];
live.forEach((value, name) => {
  seen.push(`${name}=${value}`);
  if (value === "a=1") live.delete("set-cookie");
});
console.log(seen.join(" | "));

// Appending a cookie during the walk is visited when it sorts later.
const grow = new Headers();
grow.append("set-cookie", "a=1");
grow.append("x-y", "y");
const grown: string[] = [];
grow.forEach((value, name) => {
  grown.push(`${name}=${value}`);
  if (value === "a=1") grow.append("set-cookie", "b=2");
});
console.log(grown.join(" | "));

// Only set-cookie stays separate; cookie and other repeats combine.
const plain = new Headers([
  ["cookie", "a=1"],
  ["cookie", "b=2"],
  ["accept", "x"],
  ["accept", "y"],
]);
plain.forEach((value, name) => console.log(`${name}: ${value}`));
console.log(JSON.stringify(plain.getSetCookie()));

// A response's headers walk the same way.
const response = new Response("ok", {
  headers: [
    ["set-cookie", "s=1"],
    ["set-cookie", "t=2"],
    ["content-type", "text/plain"],
  ],
});
response.headers.forEach((value, name) => console.log(`${name}: ${value}`));
