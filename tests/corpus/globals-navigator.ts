// Node 24's navigator global without @types/node: typeof is "object",
// userAgent folds to `Node.js/<major>` (the check libraries make at module
// load), hardwareConcurrency reads os.availableParallelism(), and language,
// languages and platform read the process's values. Every member is a
// getter, so the object owns no properties, and languages is one frozen
// array with stable identity.
const browser = !navigator.userAgent.startsWith("Mozilla/5.0 ");
console.log(typeof navigator, navigator.userAgent, browser);
console.log(typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers");
console.log(navigator.userAgent.split("/")[0], navigator.userAgent.length);
console.log(navigator.hardwareConcurrency > 0, Number.isInteger(navigator.hardwareConcurrency));
console.log(typeof navigator.language, navigator.languages.length, navigator.languages[0] === navigator.language);
console.log(navigator.platform.length > 0, navigator.languages === navigator.languages);
console.log(Object.isFrozen(navigator.languages), Object.keys(navigator).length);
console.log(navigator === navigator, typeof (globalThis as { navigator?: unknown }).navigator);
console.log("navigator" in globalThis, typeof (globalThis as { navigator?: unknown }).navigator);
const agent: string = navigator.userAgent;
console.log(agent === navigator.userAgent);
