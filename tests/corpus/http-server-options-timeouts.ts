// http.createServer/Server's timeout options: the documented defaults, the
// constructor assignments, the headersTimeout default derived from
// requestTimeout, the headersTimeout <= requestTimeout check, and Node's
// validateInteger ladders (ERR_OUT_OF_RANGE / ERR_INVALID_ARG_TYPE). The
// undocumented `timeout` key is ignored by Node's Server and leaves the
// property at its 0 default.
import { createServer, Server } from "node:http";

const plain = createServer();
console.log(
  "defaults",
  plain.keepAliveTimeout,
  plain.headersTimeout,
  plain.requestTimeout,
  plain.keepAliveTimeoutBuffer,
  plain.timeout,
);
plain.close();

const configured = createServer({
  keepAliveTimeout: 1234,
  headersTimeout: 2345,
  requestTimeout: 3456,
  keepAliveTimeoutBuffer: 456,
  connectionsCheckingInterval: 789,
});
console.log(
  "configured",
  configured.keepAliveTimeout,
  configured.headersTimeout,
  configured.requestTimeout,
  configured.keepAliveTimeoutBuffer,
  configured.timeout,
);
configured.close();

const derived = createServer({ requestTimeout: 1000 });
console.log("derived", derived.headersTimeout, derived.requestTimeout);
derived.close();

const explicitHeaders = createServer({ requestTimeout: 1000, headersTimeout: undefined });
console.log("explicit headers undefined", explicitHeaders.headersTimeout, explicitHeaders.requestTimeout);
explicitHeaders.close();

const disabled = createServer({ requestTimeout: 0 });
console.log("disabled", disabled.headersTimeout, disabled.requestTimeout);
disabled.close();

const explicitUndefined = createServer({ keepAliveTimeout: undefined, requestTimeout: undefined });
console.log(
  "undefined",
  explicitUndefined.keepAliveTimeout,
  explicitUndefined.headersTimeout,
  explicitUndefined.requestTimeout,
);
explicitUndefined.close();

const viaNew = new Server({ headersTimeout: 2222, requestTimeout: 5555 }, (_req, response) => {
  response.end();
});
console.log("new Server", viaNew.headersTimeout, viaNew.requestTimeout, viaNew.keepAliveTimeout);
viaNew.close();

function attempt(label: string, run: () => unknown): void {
  try {
    run();
    console.log(label, "ok");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, e.name, e.code, e.message);
  }
}

attempt("fractional", () => createServer({ requestTimeout: 1.5 }).close());
attempt("negative", () => createServer({ requestTimeout: -1 }).close());
attempt("tooBigHeaders", () => createServer({ requestTimeout: 1000, headersTimeout: 2000 }).close());
attempt("nan", () => createServer({ keepAliveTimeout: Number.NaN }).close());
attempt("string", () => createServer({ requestTimeout: "100" as unknown as number }).close());
attempt("intervalNegative", () => createServer({ connectionsCheckingInterval: -1 }).close());
attempt("intervalFractional", () => createServer({ connectionsCheckingInterval: 12.5 }).close());
attempt("intervalString", () => createServer({ connectionsCheckingInterval: "30" as unknown as number }).close());
attempt("bufferNegative", () => createServer({ keepAliveTimeoutBuffer: -5 }).close());
