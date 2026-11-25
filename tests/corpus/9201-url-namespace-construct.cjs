// The CommonJS spelling of the node:url namespace: require(...).URL and
// require(...).URLSearchParams construct like the named imports, and the
// missing-argument form throws Node's TypeError at run time.
const url = require("node:url");

const u = new url.URL("https://example.com/a?b=1#c");
console.log(u.href, u.hostname, u.searchParams.get("b"));

const params = new url.URLSearchParams("a=1&a=2");
console.log(params.getAll("a").join(","), params.has("a"), params.has("a", "2"));

try {
  const missing = new url.URL();
  console.log("no throw", missing.href);
} catch (e) {
  console.log("throw", e.name, e.code, e.message);
}

try {
  new url.URL("https://example.com", "%bad");
} catch (e) {
  console.log("throw", e.name, e.code);
}

const named = require("node:url").URL;
console.log(new named("/p", "https://example.com/base/").href);

const aliased = url.URL;
console.log(new aliased("https://example.com/alias").pathname);
const second = aliased;
console.log(new second("https://example.com/second").pathname);
