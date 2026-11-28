// A port's on<type> attribute is part of the same listener map: it counts as
// one listener, assigning the same handler twice does not add another,
// clearing it removes its registration while the property still answers the
// old value, removeAllListeners drops the type from eventNames, and assigning
// the attribute again registers it anew.
import { MessageChannel } from "node:worker_threads";

const { port1, port2 } = new MessageChannel();
const f = () => console.log("f called");
const g = () => console.log("g called");
const show = (label, fn) => {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (error) {
    console.log(label, "THROWS", error.name, error.code || "");
  }
};
port1.onmessage = f;
show("count f", () => port1.listenerCount("message"));
port1.onmessage = f;
show("count f twice", () => port1.listenerCount("message"));
port1.onmessage = null;
show("count null", () => port1.listenerCount("message"));
show("names null", () => port1.eventNames().map(String));
port1.onmessage = g;
show("count function again", () => port1.listenerCount("message"));
show("getter is g", () => port1.onmessage === g);
port1.removeAllListeners("message");
show("count after removeAll", () => port1.listenerCount("message"));
show("names after removeAll", () => port1.eventNames().map(String));
show("getter after removeAll", () => port1.onmessage === g);
port1.onmessage = g;
show("count after reassign", () => port1.listenerCount("message"));
port2.postMessage("heard");
await new Promise((resolve) => setTimeout(resolve, 20));
console.log("done");
port1.close();
port2.close();
