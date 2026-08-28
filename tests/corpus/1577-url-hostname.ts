// URL.hostname — the port-less host: lowercased for special schemes, ""
// for opaque paths and host-less file URLs, unchanged by the port. Byte-
// compared with host so the pair's split is pinned.
const a = new URL("https://Example.COM:443/path");
const b = new URL("http://localhost:3000/x");
const c = new URL("https://api.test:8443/y?q=1");
const d = new URL("file:///tmp/x");
const e = new URL("data:text/plain,hi");
const f = new URL("http://example.com/");
const g = new URL("http://[2001:DB8:0:0:1:0:0:1]/x");
console.log(a.hostname);
console.log(b.hostname);
console.log(c.hostname);
console.log(`<${d.hostname}>`);
console.log(`<${e.hostname}>`);
console.log(f.hostname);
console.log(g.hostname, g.href);
// hostname vs host: identical without a port, split by one.
console.log(b.hostname === b.host);
console.log(f.hostname === f.host);
// Composes with the other getters and unions.
const maybe: URL | undefined = c;
console.log(maybe !== undefined ? maybe.hostname : "none");
console.log(a.protocol, a.hostname, a.host, a.pathname);
