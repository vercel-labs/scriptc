// Headers copies and the cached sort-and-combine list: copies are
// independent of their source, reads see every mutation, and live
// iterators re-read the current list after a change.
function dump(label: string, h: Headers): void {
  const parts: string[] = [];
  h.forEach((value, name) => parts.push(`${name}=${value}`));
  console.log(`${label}: ${parts.join(" | ")}`);
}

// The corpus lib has no DOM iterable typings for Headers, so iterators
// are reached through an untyped view.
const iter = (h: Headers): any => h;

const source = new Headers({ "X-B": " two ", "x-a": "one", Accept: "text/html" });
source.append("accept", "application/json");
source.append("Set-Cookie", "a=1");
source.append("set-cookie", "b=2");
dump("source", source);

// A Headers copy keeps the combined values and stays separate.
const copy = new Headers(source);
source.set("x-a", "changed");
copy.append("x-c", "three");
dump("source after set", source);
dump("copy after append", copy);
console.log(JSON.stringify(copy.get("accept")), JSON.stringify(copy.get("set-cookie")));
console.log(JSON.stringify(copy.getSetCookie()));

// Copying into an empty Response and a Request, then appending a repeat.
const response = new Response("body", { headers: copy, status: 201 });
response.headers.append("accept", "*/*");
response.headers.append("cookie", "c=3");
response.headers.append("Cookie", "d=4");
dump("response", response.headers);
dump("copy unchanged", copy);
const clone = new Response(response.body, response);
dump("response clone", clone.headers);
const request = new Request("http://example.test/", { headers: copy });
console.log("request x-b", JSON.stringify(request.headers.get("X-B")));

// Every read after a mutation sees it: get, has, iteration, spread.
const h = new Headers([["x-z", "z"], ["x-m", "m"]]);
console.log([...iter(h).entries()].map(([n, v]) => `${n}:${v}`).join(","));
h.delete("x-z");
console.log([...iter(h).keys()].join(","), h.has("x-z"));
h.delete("x-missing");
console.log([...iter(h).values()].join(","));
h.append("x-a", "first");
console.log([...iter(h).entries()].map(([n, v]) => `${n}:${v}`).join(","));
h.set("X-M", "again");
console.log(JSON.stringify(h.get("x-m")), [...iter(h).keys()].join(","));

// A live iterator: mutations between steps change what comes next.
const it = iter(h).entries();
console.log(JSON.stringify(it.next().value));
h.append("x-0", "before");
console.log(JSON.stringify(it.next().value));
h.delete("x-m");
h.append("x-zz", "after");
console.log(JSON.stringify(it.next()), JSON.stringify(it.next()));

// forEach that mutates as it walks.
const walk = new Headers([["b", "2"], ["d", "4"]]);
const seen: string[] = [];
walk.forEach((value, name) => {
  seen.push(`${name}=${value}`);
  if (name === "b") {
    walk.append("c", "3");
    walk.append("a", "1");
  }
  if (name === "c") walk.set("d", "four");
});
console.log(seen.join(" | "));

// Invalid input in a copy source is still rejected (plain object source).
try {
  new Response("x", { headers: { "bad name": "v" } });
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
try {
  new Headers(source).append("x", "a\nb");
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}

// Appending an empty value leaves the separator's space at the end of the
// combined value; a copy trims it again, as Node's does. A leading
// separator has no whitespace to trim.
const spaced = new Headers();
spaced.append("a", "x");
spaced.append("a", "");
spaced.append("b", "");
spaced.append("b", "y");
spaced.append("c", "");
spaced.append("c", "");
spaced.append("cookie", "k=v");
spaced.append("cookie", "");
const spacedList = (headers: Headers): string => {
  const out: string[] = [];
  headers.forEach((value, name) => out.push(`${name}=${JSON.stringify(value)}`));
  return out.join(" ");
};
console.log(spacedList(spaced));
console.log(spacedList(new Headers(spaced)));
console.log(spacedList(new Headers(new Headers(spaced))));
console.log(spacedList(new Response("", { headers: spaced }).headers));
console.log(spacedList(new Request("http://example.test/", { headers: spaced }).headers));

// The same through duplicate constructor entries, in a Headers object and
// in a Response's own headers.
const entries: [string, string][] = [
  ["a", "x"],
  ["a", ""],
  ["c", ""],
  ["c", ""],
  ["d", "plain"],
];
const built = new Headers(entries);
console.log(spacedList(built));
console.log(spacedList(new Headers(built)));
const builtResponse = new Response("", { headers: entries });
console.log(spacedList(builtResponse.headers));
console.log(spacedList(new Headers(builtResponse.headers)));
console.log(spacedList(new Request("http://example.test/", { headers: built }).headers));
