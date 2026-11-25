// A socket's resolver may capture the socket itself (an owning transport is
// the same shape): the socket holds the resolver, and the resolver holds the
// socket and whatever it captured. Closing drops the resolver, so the cycle
// is released — repeated sockets settle and the program ends with nothing
// live (the sanitized lane's audit).
import * as dgram from "node:dgram";

type LookupCb = (error: Error | null, ip: string) => void;
type Lookup = (address: string, family: number, callback: LookupCb) => void;

const rounds = 3;
let closed = 0;

const one = (round: number): void => {
  const payload = `payload-${round}`;
  let sock: dgram.Socket | null = null;
  const lookup: Lookup = (_address, _family, callback) => {
    /* the answer is reached through the captured socket (and the payload) */
    callback(null, sock === null ? payload : "127.0.0.1");
  };
  sock = dgram.createSocket({ type: "udp4", lookup });
  const owner = sock;
  owner.on("close", () => {
    closed += 1;
    if (round + 1 < rounds) {
      one(round + 1);
      return;
    }
    console.log("closed", closed);
  });
  owner.bind(0, "capture.test", () => {
    console.log("bound", payload);
    owner.close();
  });
};

one(0);
