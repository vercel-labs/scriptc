// The Next.js proxy signature: `(request, event) => NextMiddlewareResult |
// Promise<NextMiddlewareResult>` where the result is a response class, null,
// undefined or void. Sync and async proxies run through one host.

class NextResponse {
  status: number;
  constructor(status: number) {
    this.status = status;
  }
}
type NextMiddlewareResult = NextResponse | null | undefined | void;
type NextProxy = (request: string, event: number) => NextMiddlewareResult | Promise<NextMiddlewareResult>;

const proxy: NextProxy = (request) => {
  if (request === "/health") return new NextResponse(200);
  if (request === "/async") return Promise.resolve(new NextResponse(202));
  if (request === "/null") return null;
};
const asyncProxy: NextProxy = async (request) => (request === "/a" ? new NextResponse(201) : undefined);

async function handle(p: NextProxy, request: string): Promise<string> {
  const result = await p(request, 0);
  return result ? String(result.status) : String(result);
}

// The repro shape: Promise.resolve over the handler's result.
type Handler = (n: number) => NextResponse | null | Promise<NextResponse | null>;
const h: Handler = () => new NextResponse(204);
Promise.resolve(h(1)).then((r) => console.log(r ? r.status : "none"));

async function main(): Promise<void> {
  for (const request of ["/health", "/async", "/null", "/other"]) console.log(request, await handle(proxy, request));
  for (const request of ["/a", "/b"]) console.log(request, await handle(asyncProxy, request));
}
main();
