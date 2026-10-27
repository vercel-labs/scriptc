// `return Promise.reject(err)` in an async function returns a promise of the
// function's own result type, which the async function adopts.
type Ctx = { id: string; endpoint: string; meta?: { [key: string]: string } };
async function context(endpoint: string | undefined): Promise<Ctx> {
  if (!endpoint || endpoint.length === 0) {
    return Promise.reject(new Error("invalid endpoint"));
  }
  return Promise.resolve({ id: "c1", endpoint });
}
function sync(flag: boolean): Promise<number> {
  if (flag) return Promise.reject(new TypeError("nope"));
  return Promise.resolve(3);
}
context("http://x").then((c) => console.log(c.id, c.endpoint));
context(undefined).catch((e) => console.log("rejected", String(e)));
sync(false).then((n) => console.log(n));
sync(true).catch((e) => console.log(e instanceof TypeError, String(e)));
