// A BroadcastChannel's onmessageerror is the listener Node keeps for the
// event and reports back on read, starting empty; a listener registered for
// the event coexists with onmessage, and ordinary traffic arrives as usual.
import { BroadcastChannel } from "node:worker_threads";

const channel = new BroadcastChannel("messageerror-surface");
const peer = new BroadcastChannel("messageerror-surface");
const listener = (event: any) => console.log("messageerror", event.type);
console.log("initial", typeof channel.onmessageerror, channel.onmessageerror === null);
channel.onmessageerror = listener;
console.log("assigned", channel.onmessageerror === listener);
channel.addEventListener("messageerror", listener);
channel.onmessage = (event: any) => console.log("message", JSON.stringify(event.data));
await new Promise((resolve) => setTimeout(resolve, 5));
peer.postMessage({ ok: true });
await new Promise((resolve) => setTimeout(resolve, 20));
channel.close();
peer.close();
