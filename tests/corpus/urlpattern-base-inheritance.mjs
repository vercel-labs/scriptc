// A component record's baseURL fills the components it omits by the
// standard's specificity rules: an explicit protocol stops every later
// component from inheriting, an explicit host stops the port and path,
// and so on. Inherited components are escaped as literal pattern text.
const base = "https://example.com:8443/a/b?x=1#frag";

function show(label, init) {
  try {
    const p = new URLPattern({ ...init, baseURL: base });
    console.log(
      label,
      JSON.stringify({
        protocol: p.protocol,
        username: p.username,
        password: p.password,
        hostname: p.hostname,
        port: p.port,
        pathname: p.pathname,
        search: p.search,
        hash: p.hash,
      })
    );
  } catch (error) {
    console.log(label, "threw", error.name, error.message);
  }
}

show("empty", {});
show("pathname", { pathname: "/p" });
show("pathname+port", { pathname: "/p", port: "99" });
show("protocol", { protocol: "http" });
show("protocol+hostname", { protocol: "http", hostname: "h.test" });
show("hostname", { hostname: "h.test" });
show("port", { port: "99" });
show("search", { search: "q=2" });
show("hash", { hash: "h" });
show("protocol+port", { protocol: "http", port: "99" });
show("hostname+port", { hostname: "h.test", port: "99" });
show("all but search/hash", { protocol: "http", hostname: "h.test", port: "99", pathname: "/p" });
show("relative pathname", { pathname: "p" });
show("relative dirname", { pathname: "p/" });
show("empty pathname", { pathname: "" });
show("dot segments", { pathname: "a/../p" });
show("absolute dot segments", { pathname: "/a/../p" });

// Canonicalization encodes literal text only: a custom regexp group keeps
// its bytes (a space in a class stays a space), while literal spaces around
// it are percent-encoded.
show("regex mix", { pathname: "/a b/:x([a-z ]+) c" });
show("regex relative", { pathname: "d/e f/:x([a-z ]+)" });
show("regex percent", { pathname: "/:x([a-z%]+)" });
show("regex plus", { pathname: "/:x(a+b)" });
show("escaped space", { pathname: "/a\\ b" });

// Inherited base components are literal pattern text.
function showBase(label, baseURL) {
  try {
    const p = new URLPattern({ baseURL });
    console.log(label, JSON.stringify({ pathname: p.pathname, search: p.search, hash: p.hash }));
  } catch (error) {
    console.log(label, "threw", error.name, error.message);
  }
}
showBase("escaped path", "https://h/a:b(1)*");
showBase("escaped search", "https://h/?a+b");
showBase("escaped hash", "https://h/#a(b)");

// A base URL beside a record as the second argument is the standard's
// TypeError.
try {
  new URLPattern({ pathname: "/p" }, base);
  console.log("record second-arg base accepted");
} catch (error) {
  console.log("record second-arg base", error.name, error.message);
}

// A constructor string resolves against its base: a hash or search alone
// keeps the base's path, and the empty string means the base's directory.
function showString(label, input) {
  try {
    const p = new URLPattern(input, base);
    console.log(
      label,
      JSON.stringify({
        protocol: p.protocol,
        hostname: p.hostname,
        port: p.port,
        pathname: p.pathname,
        search: p.search,
        hash: p.hash,
      })
    );
  } catch (error) {
    console.log(label, "threw", error.name, error.message);
  }
}
showString("str hash", "#f");
showString("str search", "?q");
showString("str empty", "");
showString("str dot", ".");
showString("str dots", "a/../b");
