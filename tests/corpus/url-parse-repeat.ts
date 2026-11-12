// Parsing the same URL string again. The runtime answers a repeated input
// from the components of the parse it just made, so a repeat must produce
// the same value as the first parse, and every URL object must stay its own
// mutable value: a setter, searchParams or a Request.url round trip on one
// must not reach another. The inputs also cover the dotted-decimal IPv4 host
// and the port serialization, which both format their digits directly.
const inputs = [
  "http://127.0.0.1:8080/",
  "http://127.0.0.1:8080/",
  "https://Example.COM:443/a/b?x=1#f",
  "https://Example.COM:443/a/b?x=1#f",
  "http://0x7f.1:0080/",
  "http://0x7f.1:0080/",
  "http://017700000001:0/",
  "http://017700000001:0/",
  "http://4294967295/",
  "http://1.2.3.4./",
  "http://localhost:0003000/",
  "http://localhost:65535/p",
  "http://[0:0:0:0:0:0:0:1]:8080/x",
  "  HTTP://EXAMPLE.com:0080/a\tb  ",
  "http://bücher.example/straße",
  "ws://192.168.1:9000/socket",
  "file:///tmp/x",
  "data:text/plain,hi",
];

function describe(url: URL): string {
  return JSON.stringify([url.href, url.origin, url.host, url.hostname, url.port, url.pathname, url.search]);
}

for (const input of inputs) {
  try {
    const first = new URL(input);
    const second = new URL(input);
    console.log(JSON.stringify(input), describe(first), describe(second), String(first === second));
  } catch (error) {
    console.log(JSON.stringify(input), (error as Error).name, (error as Error).message);
  }
}

// Two parses of one string are independent values.
const first = new URL("http://127.0.0.1:8080/a?x=1#f");
const second = new URL("http://127.0.0.1:8080/a?x=1#f");
first.port = "9090";
first.searchParams.set("x", "2");
first.hash = "other";
console.log(first.href, second.href, second.port, second.search, second.hash);

// An entry answered from the recorded parse still resolves and normalizes
// relative input against an independently parsed base.
const base = new URL("https://example.com/dir/page?x=1");
console.log(new URL("../other", base).href, new URL("?q=2", base).href, new URL("#top", base).href);
base.pathname = "/changed";
console.log(new URL("../other", base).href, base.href);

// Alternating and prefix-sharing inputs: every parse answers its own input.
for (const input of ["https://example.com/a", "https://example.com/ab", "https://example.com/a", "https://example.com/ab"]) {
  console.log(new URL(input).href, new URL(input).pathname);
}

// The href setter reparses through the same path.
const setter = new URL("https://example.com/1");
setter.href = "https://example.com/2?y=3";
setter.href = "https://example.com/2?y=3";
console.log(setter.href, setter.searchParams.get("y"));

// A Request built from a URL serialization and parsed back from request.url.
for (const target of ["http://127.0.0.1:3000/items/42?limit=5", "http://127.0.0.1:3000/"]) {
  const request = new Request(target);
  const parsed = new URL(request.url);
  console.log(request.url, parsed.href, parsed.pathname, parsed.searchParams.get("limit"));
}

// URL.parse takes the same parser and answers the same value for a repeat.
const direct = URL.parse("http://127.0.0.1:8080/parse");
console.log(direct?.href, URL.parse("http://127.0.0.1:8080/parse")?.href, URL.parse("nope")?.href);

// A slice handed straight to the parser can be a transient stack string; the
// entry it leaves must not answer a later parse with the slice's bytes.
const source = "xx http://example.com/sliced?q=1 yy";
console.log(new URL(source.slice(3, 32)).href);
const kept = new URL("http://example.com/sliced?q=1");
console.log(kept.href, new URL(source.slice(3, 32)).pathname, new URL(source.slice(3, 32)).search);

// An input longer than the recorded-key bound parses each time, still equally.
const long = "https://example.com/" + "a".repeat(5000) + "?q=1";
const longFirst = new URL(long);
const longSecond = new URL(long);
console.log(longFirst.pathname.length, longSecond.pathname.length, longFirst.href === longSecond.href);

// An invalid input throws the same error every time.
for (const bad of ["not a url", "http://", "https://[::1", "//missing-scheme", "http://1.2.3.256/"]) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      new URL(bad);
      console.log("accepted", JSON.stringify(bad));
    } catch (error) {
      console.log((error as Error).name, (error as Error).message);
    }
  }
}
