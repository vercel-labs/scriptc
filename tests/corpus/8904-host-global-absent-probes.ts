// Genuine absent-capability probes keep answering "undefined": Node 24 has
// no Bun, Deno or HostEventStream, so the read is exact. The host-global
// refusal (SC2020) names only globals Node really has; a program's own
// binding of such a name stays the program's, and dynamic keys still read
// the global object at run time.
declare const Bun: { readonly version?: string } | undefined;
declare const Deno: { readonly version: { deno: string } } | undefined;
declare const HostEventStream: unknown;
const scope = globalThis as Record<string, unknown>;
const probes = ["Bun", "Deno", "Temporal", "HostEventStream"];
for (const name of probes) console.log(name, typeof scope[name]);
console.log(typeof Bun, typeof Deno, typeof Temporal, typeof HostEventStream);
console.log(scope.Bun, scope.Deno);
console.log(globalThis.Temporal === undefined, "Temporal" in globalThis);
console.log(typeof URL, typeof URLSearchParams, typeof fetch, typeof performance);
const runtime = typeof Deno === "object" ? "deno" : typeof Bun === "object" ? "bun" : "node";
console.log(runtime);
if (typeof Deno === "undefined") console.log("no deno");
class FormData {
  kind = "local";
}
console.log(typeof FormData, new FormData().kind);
