// Node's navigator global read through optional chains (zod 4's
// `navigator?.userAgent?.includes("Cloudflare")` probe): navigator is
// never nullish, so each chain answers like the plain member read.
const cloudflare = typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare");
console.log(cloudflare);
console.log(navigator?.userAgent === navigator.userAgent, navigator?.userAgent?.startsWith("Node.js/"));
console.log(navigator?.userAgent?.split("/")[0] ?? "none");
