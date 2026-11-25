// fetch() takes a Request (RequestInfo) and its RequestInit cache and
// credentials members: both convert as Node converts them (String(), then
// the enum check), and the native fetch reads a Request's URL, method, and
// state.
const request = new Request("data:text/plain,hello", {
  method: "GET",
  cache: "default",
  credentials: "omit",
});
console.log(
  "request",
  request.cache,
  request.credentials,
  request.mode,
  request.redirect,
  request.method,
);
const response = await fetch(request);
console.log("text", await response.text());

const withInit = await fetch("data:text/plain,world", {
  cache: "no-store",
  credentials: "include",
});
console.log("init text", await withInit.text());

const copied = new Request(request);
console.log("copied", copied.cache, copied.credentials, await copied.text());

const override = new Request(request, { cache: "reload", credentials: "same-origin" });
console.log("override", override.cache, override.credentials);

const reload = new Request("data:text/plain,x", { cache: "reload" });
console.log("reload", reload.cache);
const forced = new Request("data:text/plain/x", { cache: "force-cache", credentials: "include" });
console.log("forced", forced.cache, forced.credentials);

try {
  new Request("data:text/plain,x", { cache: "only-if-cached" });
} catch (error) {
  console.log("only-if-cached", (error as Error).message);
}
