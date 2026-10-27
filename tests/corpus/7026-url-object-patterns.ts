// Object patterns over URLs read the URL's getters in pattern order,
// with renames and defaults, in declarations and parameters.
let built = 0;
function parse(text: string): URL {
  built++;
  return new URL(text);
}
const { protocol, hostname, port } = parse("http://localhost:8080/path?q=1#top");
console.log(protocol, hostname, port, built);
const { host: where, pathname: path = "/", search, hash, href } = parse("https://example.com/a/b?x=1&y=2#h");
console.log(where, path, search, hash, href, built);

function origin({ protocol: scheme, host, username, password }: URL): string {
  return `${scheme}//${username}:${password}@${host}`;
}
console.log(origin(new URL("ftp://user:secret@files.example.org:2121/dir")));

const { searchParams } = new URL("http://h/?a=1&b=2");
searchParams.append("c", "3");
console.log(searchParams.toString(), [...searchParams.keys()].join(","));

const { origin: o, port: p } = new URL("https://[::1]:8443/");
console.log(o, p);
for (const text of ["http://a.test:1", "http://b.test"]) {
  const { hostname: name, port: listen } = new URL(text);
  console.log(name, listen === "" ? "(default)" : listen);
}
