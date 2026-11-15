// process.features: one object holding Node's feature flags. A flag that
// describes a capability the program can use answers what the program can
// actually do; a flag that describes Node's own build answers what is
// linked into a compiled binary (no V8 inspector, no libuv, no runtime
// TypeScript loading). `native` tells the two worlds apart, so each line
// prints the same text under Node and natively.
const native = process.versions.v8 === undefined;
const features = process.features;
console.log("keys", Object.keys(features).join(","));
console.log("identity", features === process.features, typeof features, features !== null);
// Capabilities both worlds share.
console.log("debug", features.debug === false);
console.log("ipv6", features.ipv6 === true);
console.log("tls", features.tls === true, features.tls_alpn === true, features.tls_sni === true);
console.log("require_module", features.require_module === true);
// Flags that describe the linked build.
console.log("build", features.inspector === !native, features.uv === !native, features.cached_builtins === !native);
console.log("build-tls", features.tls_ocsp === !native);
console.log("typescript", features.typescript === (native ? false : "strip"));
console.log("typeof", typeof features.inspector, typeof features.debug, typeof features.uv, typeof features.ipv6);
console.log("typeof-tls", typeof features.tls, typeof features.tls_alpn, typeof features.tls_sni, typeof features.tls_ocsp);
console.log("typeof-rest", typeof features.cached_builtins, typeof features.require_module, typeof features.quic);
// A flag name Node does not define reads undefined, and a name it does
// define is findable with `in`.
console.log("unknown", features.no_such_flag, "no_such_flag" in features);
console.log("in", "tls" in features, "typescript" in features, Object.hasOwn(features, "uv"));
// A stored flag and a computed read answer the spelled member.
const flag = "tls";
console.log("stored", features[flag] === process.features.tls, features.ipv6 === process.features.ipv6);
console.log("guards", (features.tls && features.ipv6) === true, (features.debug || features.tls) === true, !features.debug === true);
