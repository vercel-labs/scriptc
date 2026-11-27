// URLPattern reads its component dictionaries with WebIDL's member rules: each
// member is one property get, in lexicographic order, and only a string value
// is a component — any other value is ignored, never stringified.
const components = [
  "baseURL",
  "hash",
  "hostname",
  "password",
  "pathname",
  "port",
  "protocol",
  "search",
  "username",
];

const describe = (label, init) => {
  const pattern = new URLPattern(init);
  console.log(
    label,
    pattern.protocol,
    pattern.username,
    pattern.password,
    pattern.hostname,
    pattern.port,
    pattern.pathname,
    pattern.search,
    pattern.hash,
  );
};
describe("num", { pathname: 42 });
describe("bool", { pathname: true });
describe("obj", { pathname: { toString: () => "/obj/" } });
describe("null", { pathname: null });
describe("array", { pathname: ["/a/"] });
describe("string", { pathname: "/s/" });
describe("num-host", { pathname: "/p/", hostname: 42 });
describe("obj-search", { pathname: "/p/", search: { toString: () => "?q" } });
describe("num-base", { pathname: "rel", baseURL: 42 });

// The ignored value is never converted.
let conversions = 0;
new URLPattern({
  pathname: {
    toString() {
      conversions++;
      return "/obj/";
    },
  },
});
console.log("conversions", conversions);

// The match input's dictionary follows the same rules.
const pattern = new URLPattern({ pathname: "/a/" });
const report = (label, input) => {
  const result = pattern.exec(input);
  console.log(label, pattern.test(input), result === null ? "null" : JSON.stringify(result.inputs));
};
report("input-num", { pathname: 42 });
report("input-obj", { pathname: { toString: () => "/a/" } });
report("input-string", { pathname: "/a/" });
report("input-empty", {});
report("input-num-search", { pathname: "/a/", search: 42 });
report("input-string-search", { pathname: "/a/", search: "?q=1" });

// One get per member, in the members' lexicographic order.
const loggingRecord = () => {
  const log = [];
  const record = {};
  for (const name of components) {
    Object.defineProperty(record, name, {
      get() {
        log.push(name);
        return name === "pathname" ? "/a/" : undefined;
      },
      enumerable: true,
    });
  }
  return { log, record };
};
const first = loggingRecord();
const orderedPattern = new URLPattern(first.record);
console.log("order", first.log.join(","), orderedPattern.pathname);
const second = loggingRecord();
const orderedHit = pattern.test(second.record);
console.log("order-exec", second.log.join(","), orderedHit);

// exec's inputs copy is the value the match read, not a second get.
let calls = 0;
const once = {
  get pathname() {
    calls++;
    return calls === 1 ? "/a/" : "*";
  },
};
const result = pattern.exec(once);
console.log("once", calls, JSON.stringify(result === null ? null : result.inputs));

// A throwing getter stops the conversion at the member the standard reads
// first, and reaches the caller.
try {
  new URLPattern({
    get hash() {
      throw new Error("hash-first");
    },
    get hostname() {
      throw new Error("hostname-second");
    },
  });
} catch (error) {
  console.log("ctor-throw", error.message);
}
try {
  pattern.exec({
    get pathname() {
      throw new Error("input-throw");
    },
  });
} catch (error) {
  console.log("exec-throw", error.message);
}
