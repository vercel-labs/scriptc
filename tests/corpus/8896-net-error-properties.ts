// A connect error's own properties, attached by the runtime where it
// builds the error: errno, code and syscall, then address and port. A typed
// listener receives the error, changes its message, and only then reads it
// through `any`, `in`, Object.keys and JSON.stringify: the properties are
// all there, in Node's order, and the message is the one just assigned.
import * as net from "node:net";

function ownKeys(value: unknown): string {
  return Object.keys(value as any).join(",");
}

function jsonCopy(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

const probe = net.createServer();
probe.listen(0, "127.0.0.1", () => {
  const port = (probe.address() as net.AddressInfo).port;
  probe.close(() => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", (err: Error) => {
      const coded = err as NodeJS.ErrnoException;
      console.log(err.name, coded.code, coded.syscall, typeof coded.errno);
      console.log(err.message === `connect ECONNREFUSED 127.0.0.1:${port}`);
      console.log("address" in err, "port" in err, "code" in err);
      err.message = "refused";
      const untyped = err as any;
      console.log(untyped.message, untyped.address, untyped.port === port, untyped.code);
      console.log(ownKeys(err));
      const copy = jsonCopy(err);
      console.log(copy.syscall, copy.address, copy.port === port, copy.message);
      console.log(untyped === err, untyped instanceof Error);
    });
    socket.on("close", (hadError: boolean) => console.log("close", hadError));
  });
});
