/* The shape of the undici shim's Request#body: a field whose DECLARED type
 * is a union (`Buffer | null`) and whose only constructor assignments sit
 * inside branches after a throwing guard. With strictPropertyInitialization
 * OFF there is no top-level assignment for the deferred-init pass to lean
 * on, and a union cannot ride the deferral — so without an initializer the
 * class is refused (tests/diagnostics/spi-off pins that direction). The
 * initializer (`= null`) is what makes the field definitely assigned, so
 * this program compiles and runs like Node. */
class Request {
  method: string;
  body: Buffer | null = null;

  constructor(method: unknown, payload: Buffer | null) {
    if (typeof method !== "string") throw new TypeError(`invalid method: ${String(method)}`);
    this.method = method;
    if (payload === null) {
      this.body = null;
    } else {
      this.body = payload;
    }
  }

  size(): number {
    return this.body === null ? -1 : this.body.byteLength;
  }
}

const posted = new Request("POST", Buffer.from("hello"));
console.log(posted.method, posted.size());
const fetched = new Request("GET", null);
console.log(fetched.method, fetched.size());
try {
  new Request(7, null);
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}
