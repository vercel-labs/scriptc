// A string-keyed read off the global object answers the constructor value
// (`globalThis["FormData"]` is `globalThis.FormData`), so calling it is
// the same refusal a direct call is (SC2020, host-global) rather than the
// dynamic global path's undefined.
const scope = globalThis as unknown as Record<string, any>;
const form = scope["FormData"]();
console.log(form);
