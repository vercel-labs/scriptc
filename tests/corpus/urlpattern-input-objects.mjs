// test() and exec() read a record input the same way the constructor reads
// its init: property gets on any object, a URL object's components included.
const pattern = new URLPattern({ pathname: "/a/" });
console.log(
  "test-url",
  pattern.test(new URL("https://example.com/a/")),
  pattern.test(new URL("https://example.com/b/")),
);
const trapped = new Proxy(
  { pathname: "/a/" },
  {
    get(target, key) {
      return key === "pathname" ? "/b/" : target[key];
    },
  },
);
console.log("proxy", pattern.test(trapped), pattern.test(new Proxy({ pathname: "/a/" }, {})));
const result = pattern.exec(new URL("https://example.com/a/"));
console.log(
  "exec",
  JSON.stringify(result.pathname.input),
  JSON.stringify(result.inputs[0].protocol),
  JSON.stringify(result.inputs[0].port),
  JSON.stringify(result.inputs[0].hostname),
);
