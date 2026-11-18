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

show("invalid regexp", () => new URLPattern({ pathname: "/([)" }));
show("duplicate names", () => new URLPattern({ pathname: "/:a/:a" }));
show("relative without base", () => new URLPattern("/books"));
