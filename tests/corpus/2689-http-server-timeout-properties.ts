// The five writable numeric http.Server timeout fields: Node 24 defaults,
// independent per-server storage, constructor initialization, optional and
// dynamic access, and static reads/writes through a typed helper. Timer
// enforcement is a separate server behavior surface.
import { createServer, Server } from "node:http";
import { createServer as createNetServer } from "node:net";

function configure(server: Server): void {
  server.timeout = 125;
  server.keepAliveTimeout = 250;
  server.keepAliveTimeoutBuffer = 300;
  server.headersTimeout = 375;
  server.requestTimeout = 500;
}

const configured = createServer();
const untouched = new Server();
const fromOption = createServer({ keepAliveTimeoutBuffer: 4321 });
const fromUndefined = createServer({ keepAliveTimeoutBuffer: undefined });

function serverFromMaybeBuffer(value: number | undefined): Server {
  return createServer({ keepAliveTimeoutBuffer: value });
}
const fromMaybeUndefined = serverFromMaybeBuffer(undefined);
const fromMaybeNumber = serverFromMaybeBuffer(2468);

console.log(
  configured.timeout,
  configured.keepAliveTimeout,
  configured.keepAliveTimeoutBuffer,
  configured.headersTimeout,
  configured.requestTimeout,
);

configure(configured);
console.log(
  configured.timeout,
  configured.keepAliveTimeout,
  configured.keepAliveTimeoutBuffer,
  configured.headersTimeout,
  configured.requestTimeout,
);
console.log(
  untouched.timeout,
  untouched.keepAliveTimeout,
  untouched.keepAliveTimeoutBuffer,
  untouched.headersTimeout,
  untouched.requestTimeout,
);

console.log("option", fromOption.keepAliveTimeoutBuffer);
console.log(
  "optional-options",
  fromUndefined.keepAliveTimeoutBuffer,
  fromMaybeUndefined.keepAliveTimeoutBuffer,
  fromMaybeNumber.keepAliveTimeoutBuffer,
);

function logOptional(server: Server | undefined): void {
  console.log("optional", server?.keepAliveTimeoutBuffer);
}
logOptional(fromOption);
logOptional(undefined);

const dynamic: any = fromOption;
console.log("dynamic", dynamic.keepAliveTimeoutBuffer);
dynamic.keepAliveTimeoutBuffer = 8765;
console.log("dynamic-set", dynamic.keepAliveTimeoutBuffer, fromOption.keepAliveTimeoutBuffer);
dynamic.timeout = "disabled";
console.log("dynamic-string", typeof dynamic.timeout, dynamic.timeout);
dynamic.timeout = undefined;
console.log("dynamic-undefined", typeof dynamic.timeout, dynamic.timeout);
dynamic.timeout = 2468;
console.log("dynamic-number", dynamic.timeout, fromOption.timeout);

const plainNetDynamic: any = createNetServer();
console.log("plain-net-dynamic", plainNetDynamic.timeout, plainNetDynamic.keepAliveTimeoutBuffer);

try {
  createServer({ keepAliveTimeoutBuffer: -1 });
} catch (err) {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    console.log(err.name, code, err.message);
  }
}
