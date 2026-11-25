// The plain absolute shape — lowercase special scheme, bare lowercase host,
// rooted path with no dot segments, query and fragment with nothing to
// escape — parses without the authority, host and path machinery. These
// cases pin the answers at and past the edges of that shape: the shapes the
// direct route accepts and the neighbours it must hand to the general
// parser.
const inputs: string[] = [
  "https://example.com/a/b?c=1&d=2#e",
  "http://example.com/",
  "http://example.com",
  "https://example.com?x=1",
  "https://example.com#frag",
  "https://example.com/?",
  "https://example.com/#",
  "ws://example.com/socket",
  "wss://example.com/socket?q=1",
  "ftp://example.com/pub/file.txt",
  "https://example.com:443/a",
  "http://example.com:80/a",
  "https://example.com:8443/a",
  "http://example.com:0/a",
  "HTTPS://EXAMPLE.COM/A/B?C=D#E",
  "https://Example.Com/A",
  "https://example.com/a/./b/../c",
  "https://example.com/a/..",
  "https://example.com/.",
  "https://example.com//a//b",
  "https://example.com/a%20b",
  "https://h/%2e%2e/x",
  "https://h/%2E/y",
  "https://h/a/%2e%2e/b",
  "https://h/a/%2e%2e",
  "https://h/%2e",
  "https://h/a%2Fb",
  "https://example.com/a b",
  "https://example.com/?q=a b",
  "https://example.com/?q=a'b",
  "https://example.com/#a b",
  "https://example.com/#a`b",
  "https://example.com/a\\b",
  "https://user:pass@example.com/a",
  "http://127.0.0.1:8080/x",
  "http://localhost:3000/api",
  "https://example.com/a?b#c?d",
  "https://example.com/a?#",
  "https://example.com/ä",
  "https://münchen.example/a",
  "file:///tmp/a.txt",
  "https://example.com/very/deep/path/segment/one/two/three",
  "  https://example.com/a  ",
  "https://example.com/a\tb",
];

for (const input of inputs) {
  const u = new URL(input);
  console.log(
    JSON.stringify([input, u.href, u.protocol, u.username, u.host, u.hostname, u.port, u.pathname, u.search, u.hash, u.origin]),
  );
}

const base = new URL("https://example.com/dir/page?x=1#f");
for (const relative of ["other", "../up", "/rooted/p", "?q=2", "#g", "//host2/p"]) {
  const u = new URL(relative, base);
  console.log(JSON.stringify([relative, u.href, u.pathname, u.search, u.hash]));
}

const plain = new URL("https://example.com/a/b?c=1#e");
plain.pathname = "/changed/path";
plain.search = "?z=9";
plain.hash = "#h";
console.log(JSON.stringify([plain.href, plain.pathname, plain.search]));
console.log(JSON.stringify([plain.searchParams.get("z"), plain.searchParams.toString()]));
