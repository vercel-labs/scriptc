// A resolver failure hands the program's own Error to the socket's 'error'
// event unchanged — same object, its code and message — for bind and for an
// unbound send's implicit bind.
import * as dgram from "node:dgram";

type LookupCb = (error: Error | null, ip: string) => void;
type Lookup = (address: string, family: number, callback: LookupCb) => void;

const boomFor = (label: string): Error & { code?: string } => {
  const boom = new Error(label) as Error & { code?: string };
  boom.code = "ENOTFOUND";
  return boom;
};

const bindPhase = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const boom = boomFor("bind lookup failed");
    const lookup: Lookup = (_address, _family, callback) => callback(boom, "");
    const sock = dgram.createSocket({ type: "udp4", lookup });
    sock.on("error", (error: Error) => {
      const typed = error as Error & { code?: string };
      console.log("bind", error === boom, typed.code, error.message);
      sock.close();
    });
    sock.on("close", () => resolve());
    sock.bind(0, "127.0.0.1");
  });

const sendPhase = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const boom = boomFor("implicit lookup failed");
    const lookup: Lookup = (_address, _family, callback) => callback(boom, "");
    const sock = dgram.createSocket({ type: "udp4", lookup });
    sock.on("error", (error: Error) => {
      const typed = error as Error & { code?: string };
      console.log("send", error === boom, typed.code, error.message);
      resolve();
    });
    sock.send("x", 9, "127.0.0.1");
  });

await bindPhase();
await sendPhase();
