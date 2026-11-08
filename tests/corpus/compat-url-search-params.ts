// URLSearchParams as Node documents it: construction from a string, a
// record and pairs, every mutator and reader, sorting, iteration and size,
// the live link to a URL's search, and the errors a bad URL or a bad pair
// list throws.
function shape(fn: () => unknown): string {
  try {
    return "ok " + String(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return err.name + " " + String(err.code) + " " + err.message;
  }
}

const params = new URLSearchParams("b=2&a=1&a=3");
params.append("c", "x y");
params.set("b", "9");
params.delete("zzz");
const visited: string[] = [];
params.forEach((value, key) => visited.push(key + ":" + value));
console.log(params.get("a"), params.getAll("a").join(","), params.get("nope"), params.has("c"), params.has("nope"));
console.log(params.size, params.toString(), visited.join("|"));

params.sort();
const pairs: string[] = [];
for (const [key, value] of params) pairs.push(key + "=" + value);
console.log(pairs.join("&"), [...params.keys()].join(","), [...params.values()].join(","));
console.log([...params.entries()].length);

params.delete("a");
console.log(params.toString(), params.size);

// Other constructors.
console.log(new URLSearchParams({ q: "1", r: "two words" }).toString());
console.log(new URLSearchParams([["a", "b"], ["c", "d&e"]]).toString());
console.log(new URLSearchParams("?lead=1").get("lead"), new URLSearchParams().toString() === "");

// A URL's searchParams is live in both directions; origin is derived.
const url = new URL("https://user:pw@example.com:8443/a/b?x=1&y=2#h");
url.searchParams.append("z", "3");
console.log(url.origin, url.search, url.searchParams.get("y"), url.href);
url.search = "?only=1";
console.log(url.searchParams.get("only"), url.searchParams.has("x"), url.host, url.hash, url.username);
console.log(URL.canParse("nope"), URL.canParse("http://a"));

// Error shapes.
console.log(shape(() => new URL("nope").href));
console.log(shape(() => new URL("/relative", "also nope").href));
