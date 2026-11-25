// An unbound send or connect resolves the implicit bind's address through
// the socket's own resolver. When that answer cannot be bound, or the
// resolver fails, the socket answers on its 'error' event — the operation's
// completion never runs — and the failed attempt keeps neither a
// descriptor nor the event loop alive: the socket stays usable, and a
// program that only handles the error ends by itself.
import * as dgram from "node:dgram";

type LookupCb = (error: Error | null, ip: string) => void;
type Lookup = (address: string, family: number, callback: LookupCb) => void;

const badAddressSend = (done: () => void): void => {
  let first = true;
  const lookup: Lookup = (address, _family, callback) => {
    if (address === "0.0.0.0" && first) {
      first = false;
      callback(null, "192.0.2.123");
      return;
    }
    callback(null, "127.0.0.1");
  };
  const sock = dgram.createSocket({ type: "udp4", lookup });
  sock.on("error", (error: Error) => {
    console.log("bad address", error.message);
    sock.send("retry", 9, "127.0.0.1", (err: Error | null) => {
      console.log("retry", err === null);
      sock.close();
    });
  });
  sock.on("close", () => {
    console.log("bad address closed");
    done();
  });
  console.log("sent");
  sock.send("first", 9, "127.0.0.1");
};

const badAddressConnect = (done: () => void): void => {
  const lookup: Lookup = (_address, _family, callback) => {
    callback(null, "192.0.2.123");
  };
  const sock = dgram.createSocket({ type: "udp4", lookup });
  sock.on("error", (error: Error) => {
    console.log("connect bad address", error.message);
    sock.close();
  });
  sock.on("close", () => {
    console.log("connect closed");
    done();
  });
  sock.connect(9, "127.0.0.1", () => console.log("connect callback ran"));
};

const lookupErrorSend = (done: () => void): void => {
  const lookup: Lookup = (_address, _family, callback) => {
    callback(new Error("no resolution"), "");
  };
  const sock = dgram.createSocket({ type: "udp4", lookup });
  sock.on("error", (error: Error) => {
    console.log("lookup error", error.message);
    done();
  });
  sock.send("x", 9, "127.0.0.1", () => console.log("send callback ran"));
};

const lookupErrorConnect = (done: () => void): void => {
  let calls = 0;
  const lookup: Lookup = (address, _family, callback) => {
    calls += 1;
    if (address === "0.0.0.0") {
      callback(new Error("no local address"), "");
      return;
    }
    callback(null, "127.0.0.1");
  };
  const sock = dgram.createSocket({ type: "udp4", lookup });
  sock.on("error", (error: Error) => {
    console.log("connect lookup error", error.message, calls);
    done();
  });
  sock.connect(9, "127.0.0.1", () => console.log("connect callback ran"));
};

badAddressSend(() =>
  badAddressConnect(() => lookupErrorSend(() => lookupErrorConnect(() => {}))),
);
