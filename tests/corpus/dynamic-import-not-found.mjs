// import() of a specifier nothing resolves rejects with Node's
// ERR_MODULE_NOT_FOUND when the call runs: a package nothing installed
// provides, and a relative path to a file that does not exist, whose error
// also carries the missing file's URL. The specifier is a URL: its escapes
// are decoded in the message's path, and its query and fragment stay in
// the url only. The program itself loads, and each call rejects again when
// repeated.
const dirs = (text) => text.replace(/\/[^\s']*\//g, "<dir>/");

async function probe(label, load) {
  try {
    await load();
    console.log(label, "loaded");
  } catch (e) {
    console.log(label, e instanceof Error, e.name, e.code);
    console.log(" ", dirs(e.message));
    console.log("  url:", e.url === undefined ? "none" : dirs(e.url));
  }
}

console.log("start");
await probe("bare", () => import("no-such-package-anywhere"));
await probe("bare subpath", () => import("no-such-package-anywhere/sub.js"));
await probe("scoped", () => import("@nobody/no-such-package"));
await probe("relative", () => import("./no-such-file.mjs"));
await probe("relative again", () => import("./no-such-file.mjs"));
await probe("parent", () => import("../no-such-dir/no-such-file.js"));
await probe("escaped", () => import("./no%20such%20file.mjs?v=1#top"));
console.log("end");
