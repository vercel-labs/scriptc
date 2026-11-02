// Node 24 does not define Bun, Deno, Temporal or HostEventStream, so a
// computed read of the global object and `… in globalThis` answer
// undefined/false — exactly what the native runtime answers for a name it does
// not know. These reads arm the host-global check (host-globals.ts), which
// covers only the Node globals the native runtime does NOT implement; those
// throw instead of answering undefined (tests/harness/host-global-dynamic.test.ts),
// so a differential program cannot exercise them.
declare const Bun: { readonly version?: string } | undefined;
declare const Deno: { readonly version: { deno: string } } | undefined;
declare const HostEventStream: unknown;

const scope = globalThis as Record<string, unknown>;
const probes = ["Bun", "Deno", "Temporal", "HostEventStream"];
for (const name of probes) console.log(name, typeof scope[name], name in scope);
console.log(typeof globalThis["Temporal"], "Temporal" in globalThis);
console.log(typeof Bun, typeof Deno, typeof HostEventStream);
const runtime = typeof Deno === "object" ? "deno" : typeof Bun === "object" ? "bun" : "node";
console.log(runtime);
const key: string = "Bun";
console.log(key in globalThis, typeof scope[key]);
