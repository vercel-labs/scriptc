// 2720 intersection expando (LIST 4.3, real case app.ts:50 Request & {rawBody})
type MyRequest = { url: string; method: string };
type WithRawBody = MyRequest & { rawBody?: Uint8Array };
function handle(req: WithRawBody): string {
  if (req.rawBody) return `body:${req.rawBody.length}`;
  return `no-body:${req.url}`;
}
console.log(handle({ url: "/a", method: "GET", rawBody: new Uint8Array([1, 2, 3]) }));
console.log(handle({ url: "/b", method: "POST" }));
interface Ext { rawBody?: Uint8Array }
type Req2 = MyRequest & Ext;
function handle2(r: Req2) { return r.rawBody ? "has" : "no"; }
console.log(handle2({ url: "/c", method: "GET" }));
