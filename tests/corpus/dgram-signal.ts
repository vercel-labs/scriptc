// createSocket's signal option: an abort closes the socket (Node's
// constructor registers the close through addAbortListener), an
// already-aborted signal closes it without a bind, and a value that only
// looks like a signal fails the construction.
import * as dgram from "node:dgram";

const controller = new AbortController();
const socket = dgram.createSocket({ type: "udp4", signal: controller.signal });
const events: string[] = [];
socket.on("listening", () => events.push("listening"));
socket.on("close", () => events.push("close"));
socket.on("error", (err) => events.push(`error ${(err as NodeJS.ErrnoException).code}`));
socket.bind(0, "127.0.0.1", () => {
  events.push("bound");
  controller.abort();
});
await new Promise<void>((resolve) => socket.once("close", () => resolve()));
console.log("aborted", events.join(","), (() => {
  try {
    socket.address();
    return "address";
  } catch (err) {
    return (err as Error).message;
  }
})());

const early = new AbortController();
early.abort();
const aborted = dgram.createSocket({ type: "udp4", signal: early.signal });
const earlyEvents: string[] = [];
aborted.on("listening", () => earlyEvents.push("listening"));
aborted.on("close", () => earlyEvents.push("close"));
await new Promise<void>((resolve) => aborted.once("close", () => resolve()));
console.log("early", earlyEvents.join(","));

try {
  dgram.createSocket({ type: "udp4", signal: { aborted: false } as unknown as AbortSignal });
  console.log("duck typed", "created");
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  console.log("duck typed", e.code, e.message);
}
