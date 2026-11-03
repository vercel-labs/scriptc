// new url.URL(...) / new url.URLSearchParams(...): a member of the node:url
// namespace names the same class the named import binds, so construction
// (including the catchable "Invalid URL" TypeError) lowers like it.
import * as url from "node:url";

const parsed = new url.URL("/x", "https://example.com/d/");
console.log(parsed.href, parsed.pathname, parsed.origin);

const direct = new url.URL("https://user:pass@example.com:8080/a?b=1#c");
console.log(direct.href, direct.username, direct.port, direct.search, direct.hash);

const params = new url.URLSearchParams("a=1&b=2&a=3");
console.log(params.get("a"), params.getAll("a").join(","), params.toString());
const pairs = new url.URLSearchParams([["k", "v"], ["k", "w"]]);
console.log(pairs.toString());
const record = new url.URLSearchParams({ q: "hi there", n: "2" });
console.log(record.toString(), record.size);
console.log(new url.URLSearchParams().toString(), new url.URLSearchParams().size);

for (const bad of ["not a url", "/x"]) {
  try {
    const u = new url.URL(bad);
    console.log("no throw", u.href);
  } catch (e: any) {
    console.log("throw", e.name, e.code, e.message);
  }
}

// A URL argument keeps the instance's components.
const copy = new url.URL(direct);
console.log(copy.href);
// searchParams is live on a namespace-constructed URL.
copy.searchParams.append("z", "9");
console.log(copy.href);
