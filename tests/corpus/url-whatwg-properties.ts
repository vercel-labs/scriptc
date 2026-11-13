// The URL class as the WHATWG standard and Node 24 define it: every
// component getter over the special schemes, non-special schemes, an
// opaque path, a file URL, IPv4 and IPv6 hosts and internationalized
// text; the setters with valid and invalid input; copy construction and a
// URL used as the base; the live searchParams view; origin; and the
// construction errors. Each line prints one observation.

const props = (u: URL): string =>
  JSON.stringify([
    u.href,
    u.protocol,
    u.username,
    u.password,
    u.host,
    u.hostname,
    u.port,
    u.pathname,
    u.search,
    u.hash,
    u.origin,
  ]);

// Component getters. Default ports vanish, credentials stay encoded, the
// path is normalized, and a non-special scheme keeps an opaque path.
const hrefs = [
  "https://user:pa%20ss@example.com:8080/a/b?x=1&y=2#h",
  "https://example.com",
  "https://example.com/",
  "http://a:80/x",
  "https://a:443/x",
  "http://a:8080/x",
  "ws://a:80/x",
  "wss://a:443/x",
  "ftp://u:p@h:21/p",
  "file:///a/b",
  "file://host/a",
  "mailto:a@b",
  "data:text/plain,hi",
  "blob:https://a/b",
  "https://[::1]:8080/",
  "https://1.2.3.4/",
  "https://bücher.example/ü?ü=ü#ü",
  "https://a/%41",
  "https://a/b/../c",
  "https://a?",
  "https://a#x",
  "https://a/?",
  "https://a/#",
];
for (const href of hrefs) console.log("props", href, props(new URL(href)));

// A URL's query is its live searchParams list.
const query = new URL("https://a/?b=1&a=2").searchParams;
console.log("searchParams", JSON.stringify([...query.entries()]), query.size);
const bare = new URL("https://a/").searchParams;
console.log("searchParams empty", bare.toString() === "", bare.size);
const live = new URL("https://example.com/p?a=1#f");
live.searchParams.append("b", "2");
console.log("live", live.href, live.search, live.searchParams.size);
live.search = "?c=3";
console.log("replaced", live.searchParams.get("c"), live.searchParams.has("a"), live.href);
live.searchParams.sort();
console.log("sorted", live.href);

// Setters: each one either rewrites its component or is ignored.
const written = new URL("https://a:1/b?c#d");
const set = (label: string, apply: () => void): void => {
  apply();
  console.log("set", label, written.href);
};
set("protocol http", () => {
  written.protocol = "http:";
});
set("protocol ftp", () => {
  written.protocol = "ftp";
});
set("protocol bogus", () => {
  written.protocol = "bogus";
});
set("username", () => {
  written.username = "u s@";
});
set("password", () => {
  written.password = "p:a";
});
set("host", () => {
  written.host = "h:99";
});
set("host no port", () => {
  written.host = "h";
});
set("hostname", () => {
  written.hostname = "other";
});
set("hostname with port", () => {
  written.hostname = "h:99";
});
set("port", () => {
  written.port = "8080";
});
set("port empty", () => {
  written.port = "";
});
set("port abc", () => {
  written.port = "abc";
});
set("port 0", () => {
  written.port = "0";
});
set("pathname", () => {
  written.pathname = "/x y";
});
set("pathname query", () => {
  written.pathname = "/a?b";
});
set("search", () => {
  written.search = "?q=1 2";
});
set("search hash", () => {
  written.search = "?a=1#b";
});
set("hash", () => {
  written.hash = "#h h";
});
set("hash empty", () => {
  written.hash = "";
});
set("href", () => {
  written.href = "https://z/1";
});

// An invalid href assignment throws and leaves the URL unchanged.
const kept = new URL("https://a/b");
try {
  kept.href = "nope";
  console.log("href invalid kept");
} catch (e) {
  const err = e as Error & { code?: string };
  console.log("href invalid", err.name, err.code, err.message);
}
console.log("href after", kept.href);

// Copy construction, a URL as the base, and the JSON form.
const original = new URL("https://user:pw@example.com:8080/a?b=1#c");
console.log(
  "copy",
  new URL(original).href,
  new URL(original, "https://other/x").href,
  new URL("/x", original).href,
  JSON.stringify(original),
  original.toJSON() === original.href,
  original.toString() === original.href,
);

// Construction errors carry Node's code and message.
const failures = ["not a url", "", "//h/p", "/x", "https://a:99999/", "https://a b"];
for (const input of failures) {
  try {
    console.log("new", JSON.stringify(input), new URL(input).href);
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log("new", JSON.stringify(input), err.name, err.code, err.message);
  }
}
try {
  console.log("new base", new URL("/x", "https://a/b").href, new URL("/x", undefined).href);
} catch (e) {
  const err = e as Error & { code?: string };
  console.log("new base", err.name, err.code, err.message);
}
try {
  console.log("new bad base", new URL("/x", "nope").href);
} catch (e) {
  const err = e as Error & { code?: string };
  console.log("new bad base", err.name, err.code, err.message);
}
