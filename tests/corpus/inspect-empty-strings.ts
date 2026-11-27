// The inspector appends empty strings: every empty URL component, an empty
// string among several console.log arguments, and an empty list join. An
// empty append must not reach the copy with a buffer that has no storage
// yet (the sanitized lane's UBSan reports it as a null destination).
const url = new URL("https://example.com/");
console.log("url", url);
console.log(
  "parts",
  url.protocol,
  url.username,
  url.password,
  url.hostname,
  url.port,
  url.pathname,
  url.search,
  url.hash,
);
const empty = "";
console.log("a", empty, "b", empty, "c");
const params = new URLSearchParams("");
console.log("params", params, String(params.toString()), "end");
console.log([url.username, url.password, url.port, url.search, url.hash].join(","));
console.log("joined", [empty, empty].join("|"), empty, "done");
