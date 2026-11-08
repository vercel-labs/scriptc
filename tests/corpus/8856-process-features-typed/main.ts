// process.features under @types/node, where each flag is declared and
// `typescript` is "strip" | "transform" | false. A compiled binary cannot
// load TypeScript source at run time, so it answers false where Node 24
// answers "strip"; `native` tells the two worlds apart so both print the
// same text.
const native = process.versions.v8 === undefined;

const mode = process.features.typescript;
console.log("typescript", native ? mode === false : mode === "strip");
console.log("typeof", typeof mode === (native ? "boolean" : "string"));

// The loader guard this flag exists for.
function canImportTypeScript(): boolean {
  return process.features.typescript !== false;
}
console.log("can import .ts", canImportTypeScript() === !native);
let strips = false;
if (process.features.typescript) strips = true;
console.log("strips", strips === !native);

console.log("inspector", process.features.inspector === !native);
console.log("uv", process.features.uv === !native);
console.log("cached_builtins", process.features.cached_builtins === !native);
console.log("tls_ocsp", process.features.tls_ocsp === !native);
console.log(
  "shared",
  process.features.debug,
  process.features.ipv6,
  process.features.tls,
  process.features.tls_alpn,
  process.features.tls_sni,
  process.features.require_module,
);

const features: NodeJS.ProcessFeatures = process.features;
console.log("same", features === process.features);
console.log("in", "typescript" in features, "require_module" in features, "sea" in features);

function describe(flags: NodeJS.ProcessFeatures): string {
  const parts = [flags.tls ? "tls" : "no-tls", flags.ipv6 ? "ipv6" : "no-ipv6"];
  parts.push(flags.debug ? "debug" : "release");
  return parts.join(" ");
}
console.log(describe(process.features));
console.log("keys", Object.keys(features).join(","));
