// process.features: Node's feature flags are booleans (and `typescript` a
// mode), never undefined. A flag that describes a capability the program
// can use answers what Node answers; a flag that describes Node's own
// build answers what is true of a compiled binary. `native` tells the two
// worlds apart (a compiled binary links no V8), so each line prints the
// same text under Node and natively while fixing the native value.
const native = process.versions.v8 === undefined;

// The same value in both worlds.
console.log("debug", process.features.debug);
console.log("ipv6", process.features.ipv6);
console.log("tls", process.features.tls);
console.log("tls_alpn", process.features.tls_alpn);
console.log("tls_sni", process.features.tls_sni);
console.log("openssl_is_boringssl", process.features.openssl_is_boringssl);
console.log("require_module", process.features.require_module);
console.log("quic", process.features.quic);

// Node's own build: true there, false in a compiled binary.
console.log("inspector", process.features.inspector === !native);
console.log("uv", process.features.uv === !native);
console.log("cached_builtins", process.features.cached_builtins === !native);
// requestOCSP is not implemented natively.
console.log("tls_ocsp", process.features.tls_ocsp === !native);

// Every flag is a boolean, so a feature test never sees undefined.
console.log(
  "typeof",
  typeof process.features.inspector,
  typeof process.features.debug,
  typeof process.features.uv,
  typeof process.features.ipv6,
  typeof process.features.tls,
  typeof process.features.tls_alpn,
  typeof process.features.tls_sni,
  typeof process.features.tls_ocsp,
  typeof process.features.openssl_is_boringssl,
  typeof process.features.cached_builtins,
  typeof process.features.require_module,
  typeof process.features.quic,
);

// A name Node does not define still reads undefined.
console.log("unknown", process.features.no_such_flag);

// The guards programs write.
let inspecting = false;
if (process.features.inspector) inspecting = true;
console.log("inspector branch", inspecting === !native);
const usable = process.features.tls && process.features.ipv6;
console.log("usable", usable);
console.log("or", process.features.debug || process.features.quic || "neither");
console.log("not", !process.features.debug, !process.features.tls);

// The object: one identity, Node's keys in Node's order.
const features = process.features;
console.log("same", features === process.features);
console.log(
  "keys",
  Object.keys(features).join(","),
);
console.log("in", "inspector" in features, "typescript" in features, "sea" in features);
console.log("count", Object.keys(features).length);
const { tls, ipv6 } = process.features;
console.log("destructured", tls, ipv6);
console.log("alias", features.tls, features.debug, features.inspector === !native);
// The stored object and the direct reads agree on every flag.
console.log(
  "consistent",
  features.inspector === process.features.inspector &&
    features.debug === process.features.debug &&
    features.uv === process.features.uv &&
    features.ipv6 === process.features.ipv6 &&
    features.tls_alpn === process.features.tls_alpn &&
    features.tls_sni === process.features.tls_sni &&
    features.tls_ocsp === process.features.tls_ocsp &&
    features.tls === process.features.tls &&
    features.openssl_is_boringssl === process.features.openssl_is_boringssl &&
    features.cached_builtins === process.features.cached_builtins &&
    features.require_module === process.features.require_module &&
    features.quic === process.features.quic &&
    features.typescript === process.features.typescript,
);

// `typescript` is a mode in Node ("strip" by default) and false in a
// compiled binary, which cannot load TypeScript source at run time.
const mode = process.features.typescript;
console.log("typescript", native ? mode === false : mode === "strip");
console.log("loads .ts", (process.features.typescript !== false) === !native);
