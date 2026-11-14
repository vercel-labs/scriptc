// The happy-eyeballs dial's per-address events: 'connectionAttempt'
// before each dial, 'connectionAttemptFailed' with the address error,
// 'connectionAttemptTimeout' when an attempt outlives the budget, and the
// autoSelectFamilyAttemptedAddresses log. A caller resolver fixes the
// answers: a refused first address falls through to the listening one,
// and a blackholed first address times out (or fails fast where the
// network answers) to the same listener. Addresses print without their
// port, which is the bound one throughout.
import * as net from "node:net";
import type { LookupAddress } from "node:dns";

function lookupAnswering(...addresses: string[]) {
  return (
    _host: string,
    _options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    const list: LookupAddress[] = addresses.map((address) => ({ address, family: 4 }));
    setImmediate(() => callback(null, list));
  };
}

/** The dial's events, printed with `label`: the attempt family, the
 * failure's code, and the addresses tried so far at connect time. */
function trace(socket: net.Socket, label: string, expectedPort: number): void {
  socket.on("connectionAttempt", (address: string, port: number, family: number) => {
    console.log(label, "attempt", address, family, port === expectedPort);
  });
  socket.on("connectionAttemptFailed", (address: string, port: number, family: number, error: Error) => {
    const code = (error as any).code;
    console.log(label, "failed", address, family, port === expectedPort, code);
  });
  socket.on("connectionAttemptTimeout", (address: string, port: number, family: number) => {
    console.log(label, "timeout", address, family, port === expectedPort);
  });
  socket.on("error", () => {});
}

const attempted = (socket: net.Socket): string => {
  const raw: any = socket;
  const list: any = raw.autoSelectFamilyAttemptedAddresses;
  if (list === undefined) return "undefined";
  const bare: string[] = list.map((entry: string) => entry.slice(0, entry.lastIndexOf(":")));
  return bare.join(",");
};

const server = net.createServer((socket) => socket.on("error", () => {}));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;

  // One answer: one attempt, no attempted-address log.
  const single = net.connect({ host: "one.example", port, autoSelectFamily: true, lookup: lookupAnswering("127.0.0.1") });
  trace(single, "single", port);
  single.on("connect", () => {
    console.log("single connected", attempted(single));
    single.destroy();
  });
  single.on("close", () => {
    // A refused address first: the failure carries connect's code, then
    // the second answer connects and both appear in the log.
    const retry = net.connect({
      host: "two.example",
      port,
      autoSelectFamily: true,
      lookup: lookupAnswering("127.0.0.2", "127.0.0.1"),
    });
    trace(retry, "retry", port);
    retry.on("connect", () => {
      console.log("retry connected", attempted(retry));
      retry.destroy();
    });
    retry.on("close", () => {
      // A blackholed first address past the 50ms budget: the timeout
      // event, then the listener's answer. Where the address fails
      // outright instead, the failure event stands in its place.
      const slow = net.connect({
        host: "slow.example",
        port,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 50,
        lookup: lookupAnswering("169.254.169.254", "127.0.0.1"),
      });
      trace(slow, "slow", port);
      slow.on("connect", () => {
        console.log("slow connected", attempted(slow));
        slow.destroy();
      });
      slow.on("close", () => server.close(() => console.log("closed")));
    });
  });
});
