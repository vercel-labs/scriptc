// undici-types declares Headers members as readonly function properties
// (`readonly get: (name: string) => string | null`). A fetched Response
// is a native handle that answers those names as methods, so each call
// must dispatch by name instead of reading the member and calling it.
const base = process.argv[2];

const res = await fetch(`${base}/headers`);
console.log(
  "direct:",
  res.headers.get("x-kind"),
  res.headers.get("missing"),
  res.headers.has("x-kind"),
  res.headers.has("missing"),
);

const headers: Headers = res.headers;
console.log("typed local:", headers.get("x-kind"), headers.has("content-type"));

const contentType = (source: Headers): string | null => source.get("content-type");
console.log("parameter:", contentType(res.headers));

const request = async (path: string): Promise<Response> => fetch(`${base}${path}`);
const viaHelper = await request("/headers");
console.log("helper:", viaHelper.headers.get("x-kind"), await viaHelper.text());
await res.text();
