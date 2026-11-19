// The global URLPattern: pattern strings and component records, named
// parts, wildcards, regexp parts and modifiers, exec's component results
// with their groups, test, and the compiled component properties.
function show(label, run) {
  try {
    console.log(label, JSON.stringify(run()));
  } catch (error) {
    console.log(label, "threw", error.name, error.message);
  }
}

const books = new URLPattern("https://example.com/books/:id");
console.log("exec", JSON.stringify(books.exec("https://example.com/books/42")));
console.log(
  "test",
  books.test("https://example.com/books/42"),
  books.test("https://example.com/other/42"),
  books.test("https://example.com/books/42/extra")
);
console.log(
  "props",
  books.protocol,
  books.hostname,
  JSON.stringify(books.port),
  books.pathname,
  books.search,
  books.hash,
  books.hasRegExpGroups
);

const wild = new URLPattern({ pathname: "/files/*" });
console.log("wild", JSON.stringify(wild.exec("http://x/files/a/b")), wild.hasRegExpGroups);

const digits = new URLPattern({ pathname: "/books/:id(\\d+)" });
console.log(
  "digits",
  digits.hasRegExpGroups,
  digits.test("http://x/books/42"),
  digits.test("http://x/books/ab")
);
console.log("digits exec", JSON.stringify(digits.exec("http://x/books/42")));

const optional = new URLPattern({ pathname: "/a/:name?" });
console.log("optional", JSON.stringify(optional.exec("http://x/a")));
console.log("optional set", JSON.stringify(optional.exec("http://x/a/b")));

const relative = new URLPattern("/books/:id", "https://example.com/api/");
console.log("relative props", relative.protocol, relative.hostname, relative.pathname);
console.log("relative", JSON.stringify(relative.exec("/books/7")));
console.log(
  "relative abs",
  relative.test("https://example.com/books/7"),
  relative.test("https://example.com/api/books/7")
);

const insensitive = new URLPattern({ pathname: "/Books/:id" }, { ignoreCase: true });
console.log("insensitive", insensitive.test("HTTP://X/books/9"), insensitive.pathname);

const fromRecord = new URLPattern({ protocol: "https", hostname: "h", pathname: "/x" });
console.log("record", JSON.stringify(fromRecord.exec({ protocol: "https", hostname: "h", pathname: "/x" })));
console.log("record pathname only", JSON.stringify(fromRecord.exec({ pathname: "/x" })));

const empty = new URLPattern();
console.log("empty", empty.test("https://anything/x"), empty.pathname, empty.hasRegExpGroups);

const query = new URLPattern("https://h/books/:id?q=:term");
console.log("query", JSON.stringify(query.exec("https://h/books/7?q=hello")));

const explicitPort = new URLPattern("https://h:8080/x");
console.log(
  "explicit port",
  explicitPort.hostname,
  explicitPort.port,
  explicitPort.test("https://h:8080/x")
);

const defaultPort = new URLPattern("https://h:443/x");
console.log("default port", JSON.stringify(defaultPort.port), defaultPort.test("https://h/x"));

show("record base arg", () => fromRecord.exec({}, "https://h/x"));
console.log("record base url", JSON.stringify(fromRecord.exec({ baseURL: "https://h/x" })));
console.log(
  "record relative",
  JSON.stringify(fromRecord.exec({ pathname: "x", baseURL: "https://h/" }))
);
console.log("record omitted base", fromRecord.exec({ pathname: "x" }));
console.log(
  "record dot segments",
  JSON.stringify(fromRecord.exec({ pathname: "/a/../x", baseURL: "https://h/" }))
);

const anyPath = new URLPattern({ pathname: "*" });
console.log("path dot segments", anyPath.exec({ pathname: "/a/./x" }).pathname.input);
console.log("path relative dots", JSON.stringify(anyPath.exec({ pathname: "a/../x" }).pathname.input));
console.log("path backslash", anyPath.exec({ pathname: "/a\\b" }).pathname.input);
console.log("path backslash dots", anyPath.exec({ pathname: "/a\\..\\b" }).pathname.input);
console.log("path encoded dots", anyPath.exec({ pathname: "/a/%2e%2e/b" }).pathname.input);
console.log(
  "path trailing dot",
  JSON.stringify(anyPath.exec({ pathname: "/a/." }).pathname.input)
);
console.log("path root dot", JSON.stringify(anyPath.exec({ pathname: "/.." }).pathname.input));
console.log(
  "record canonicalized",
  JSON.stringify(
    fromRecord.exec({ protocol: "HTTPS:", hostname: "H", port: "443", pathname: "/x" })
  )
);

// A component's text is that component, never a URL that could smuggle a
// different authority past an allowlist.
const trusted = new URLPattern("https://trusted.example/x");
console.log(
  "pathname url text",
  trusted.exec({ pathname: "https://attacker.example/x", baseURL: "https://trusted.example/" })
);
const trustedRecord = new URLPattern({ protocol: "https", hostname: "trusted.example", pathname: "*" });
console.log(
  "protocol url text",
  trustedRecord.exec({ protocol: "https://attacker.example", hostname: "trusted.example", pathname: "/x" })
);
console.log(
  "hostname userinfo text",
  new URLPattern({ hostname: "*" }).exec({ hostname: "trusted.example@attacker.example" })
);
console.log(
  "allowlist controls",
  trusted.exec({ pathname: "/x", baseURL: "https://trusted.example/" }) !== null,
  trustedRecord.exec({ protocol: "https:", hostname: "trusted.example", pathname: "/x" }) !== null
);

show("invalid regexp", () => new URLPattern({ pathname: "/([)" }));
show("duplicate names", () => new URLPattern({ pathname: "/:a/:a" }));
show("relative without base", () => new URLPattern("/books"));
