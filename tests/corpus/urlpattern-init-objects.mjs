// The constructor reads its init dictionary the way WebIDL does: property
// gets on any object, so a URL object's components and a Proxy's traps
// contribute, an array answers the empty dictionary, and a plain object keeps
// working.
const url = new URL("https://user:pw@example.com:8080/a/?q=1#h");
const fromUrl = new URLPattern(url);
console.log(
  "url",
  fromUrl.protocol,
  fromUrl.username,
  fromUrl.password,
  fromUrl.hostname,
  fromUrl.port,
  fromUrl.pathname,
  fromUrl.search,
  fromUrl.hash,
);
const fromProxy = new URLPattern(
  new Proxy(
    { pathname: "/x" },
    {
      get(target, key) {
        return key === "pathname" ? "/from-trap" : target[key];
      },
    },
  ),
);
console.log("proxy", fromProxy.pathname, fromProxy.test("https://example.com/from-trap"), fromProxy.test("https://example.com/x"));
const fromPlain = new URLPattern({ pathname: "/y" });
console.log("plain", fromPlain.pathname, fromPlain.test("https://example.com/y"));
const fromArray = new URLPattern([]);
console.log("array", fromArray.pathname, fromArray.test("https://example.com/anything"));
