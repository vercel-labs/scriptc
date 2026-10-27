// ky's feature probes: typeof Node's Web-platform constructor globals and
// their static methods answers "function" without materializing the value.
export const supportsAbortController = typeof globalThis.AbortController === "function";
export const supportsAbortSignal =
  typeof globalThis.AbortSignal === "function" && typeof globalThis.AbortSignal.any === "function";
console.log(supportsAbortController, supportsAbortSignal);
console.log(typeof AbortSignal.timeout, typeof AbortSignal.abort, typeof globalThis.AbortSignal.any);
console.log(typeof Response.json, typeof Response.error, typeof URL.canParse, typeof Promise.withResolvers);
console.log(typeof AbortSignal, typeof globalThis.URL, typeof Headers, typeof globalThis.TextEncoder, typeof URLSearchParams);
const signal = AbortSignal.abort("stop");
console.log(signal.aborted, signal.reason);
