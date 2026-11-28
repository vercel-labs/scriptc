// URLPattern syntax beyond the core: the ? * + modifiers, escapes, {...}
// groups, search and hash patterns, hostname and port patterns, and copying
// an existing pattern.
function t(label, pattern, input) {
  try {
    console.log(label, pattern.test(input), JSON.stringify(pattern.exec(input)));
  } catch (error) {
    console.log(label, "threw", error.name, error.message);
  }
}

const opt = new URLPattern({ pathname: "/a/:x?" });
t("opt empty", opt, "http://h/a");
t("opt set", opt, "http://h/a/b");

const star = new URLPattern({ pathname: "/a/:x*" });
t("star none", star, "http://h/a");
t("star many", star, "http://h/a/b/c");

const plus = new URLPattern({ pathname: "/a/:x+" });
t("plus none", plus, "http://h/a");
t("plus one", plus, "http://h/a/b");

const group = new URLPattern({ pathname: "/books{/:id}?" });
t("group none", group, "http://h/books");
t("group id", group, "http://h/books/7");

const escaped = new URLPattern({ pathname: "/lit/\\*/:id" });
t("escaped", escaped, "http://h/lit/*/9");
console.log("escaped pattern", escaped.pathname, escaped.hasRegExpGroups);

const search = new URLPattern({ search: "q=:term&page=:page" });
t("search", search, "http://h/x?q=cats&page=2");
t("search miss", search, "http://h/x?q=cats");

const hash = new URLPattern("https://h/p#:section");
t("hash", hash, "https://h/p#intro");

const ctorQuery = new URLPattern("https://h/books/:id?q=:term");
t("constructor query", ctorQuery, "https://h/books/7?q=hello");
console.log("constructor query props", ctorQuery.pathname, ctorQuery.search, ctorQuery.hash);

// ":" before an identifier starts a name, so the userinfo's colon joins the
// username instead of splitting off a password.
try {
  new URLPattern({ pathname: "/:a((x))/:b" });
  console.log("nested capture accepted");
} catch (error) {
  console.log("nested capture refused", error.name, error.message);
}
const nonCapturing = new URLPattern({ pathname: "/:a((?:x)y)/:b" });
t("noncapturing group", nonCapturing, "https://h/xy/z");

const colonUserinfo = new URLPattern("https://u:p@h:8/x");
console.log(
  "userinfo props",
  colonUserinfo.username,
  colonUserinfo.password,
  colonUserinfo.hostname,
  colonUserinfo.port
);

const host = new URLPattern("https://*.example.com/:file");
t("host", host, "https://api.example.com/a.txt");
t("host miss", host, "https://api.other.com/a.txt");
console.log("host props", host.protocol, host.hostname, host.port, host.pathname);

const port = new URLPattern({ hostname: "h", port: ":p" });
t("port", port, "http://h:8080/x");
t("port default", port, "http://h/x");

const userinfo = new URLPattern({ username: "u", password: "p", hostname: "h", pathname: "/" });
t("userinfo", userinfo, "http://u:p@h/");
t("userinfo miss", userinfo, "http://u:q@h/");

const copy = new URLPattern(opt);
console.log("copy", copy.pathname, copy.test("http://h/a/z"));

const base = new URLPattern({ pathname: "/x", baseURL: "https://base.example/a/b" });
t("init base", base, "https://base.example/x");
try {
  new URLPattern({ pathname: "/x" }, "https://base.example/a/b");
  console.log("init positional base ok");
} catch (error) {
  console.log("init positional base", error.name, error.message);
}

try {
  const ipv6 = new URLPattern("http://[::1]:8080/x");
  t("ipv6", ipv6, "http://[::1]:8080/x");
  console.log("ipv6 props", ipv6.hostname, ipv6.port);
} catch (error) {
  console.log("ipv6", error.name, error.message);
}

try {
  new URLPattern("*");
  console.log("wildcard only ok");
} catch (error) {
  console.log("wildcard only", error.name, error.message);
}

try {
  new URLPattern({ pathname: "/a{" });
  console.log("unclosed group ok");
} catch (error) {
  console.log("unclosed group", error.name, error.message);
}
