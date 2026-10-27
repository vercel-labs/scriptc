// Class fields typed as native fetch handles (Headers, Request, Response),
// directly, optional, nullable, in arrays, and inside record fields, hold
// the live handle: mutation through one reference is seen through another.
class Holder {
  headers: Headers;
  list: Headers[] = [];
  maybe?: Response;
  req: Request | null = null;
  bag: { headers: Headers; status: number };
  constructor(headers: Headers) {
    this.headers = headers;
    this.bag = { headers, status: 1 };
  }
}
const holder = new Holder(new Headers({ a: "1" }));
console.log(holder.headers.get("a"), holder.list.length, holder.maybe === undefined, holder.req);
holder.list.push(new Headers({ b: "2" }));
holder.maybe = new Response("x", { status: 201 });
holder.req = new Request("http://localhost/p", { method: "POST" });
console.log(holder.list[0]!.get("b"), holder.maybe.status, holder.req.method, holder.req.url);
holder.headers.set("c", "3");
console.log(holder.bag.headers.get("c"), holder.bag.headers === holder.headers);

// Symbol-keyed fields hold the handles the same way.
const NATIVE = Symbol("native");
class Wrapper {
  [NATIVE]: Response;
  constructor(body: string) {
    this[NATIVE] = new Response(body, { status: 202 });
  }
  get status(): number {
    return this[NATIVE].status;
  }
}
const wrapped = new Wrapper("ok");
console.log(wrapped.status, wrapped[NATIVE].headers.get("content-type"));
