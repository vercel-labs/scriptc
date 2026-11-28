// URLPattern record match inputs are canonicalized component by component:
// a hostname is host text only (a hidden port makes the input invalid), a
// port is its leading digits (text after them is not authority, and a
// special scheme's default port is the empty port), a trailing ".." carries
// the directory's slash, and a getter-backed component in the init record
// answers its getter.
function show(label, f) {
  try {
    console.log(label, JSON.stringify(f()));
  } catch (e) {
    console.log(label, "threw", e.name);
  }
}

show("input-host-port", () =>
  new URLPattern({}).test({ protocol: "https", hostname: "a.example.com:8080" }));
show("input-host-path", () =>
  new URLPattern({ hostname: "a.example.com" }).test({
    protocol: "https",
    hostname: "a.example.com/path",
  }));
show("input-port-at", () =>
  new URLPattern({ port: "80" }).test({
    protocol: "https",
    hostname: "trusted.example",
    port: "80@evil.example",
  }));
show("input-port-padded", () =>
  new URLPattern({ port: "80" }).test({ protocol: "https", port: "0080" }));
show("input-port-default", () => {
  const result = new URLPattern({}).exec({
    protocol: "https",
    port: "443",
    hostname: "h",
    pathname: "/",
  });
  return result === null ? null : [result.port.input, result.port.groups];
});
show("input-dotdot", () => [
  new URLPattern({ pathname: "/public" }).test({ pathname: "/public/child/.." }),
  new URLPattern({ pathname: "/public/" }).test({ pathname: "/public/child/.." }),
]);

let reads = 0;
const init = {};
Object.defineProperty(init, "hostname", {
  enumerable: true,
  get() {
    reads += 1;
    return "example.com";
  },
});
show("getter-init", () => {
  const pattern = new URLPattern(init);
  return [pattern.hostname, reads];
});
