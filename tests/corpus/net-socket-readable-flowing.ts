// readableFlowing follows Node's flow decision: a 'readable' listener pins
// the stream in paused mode even when 'data' listeners are registered, and
// resume() does not put it back.
import * as net from "node:net";

const s = new net.Socket();
console.log("bare", String(s.readableFlowing));
s.on("data", () => {});
console.log("data", String(s.readableFlowing));
s.on("readable", () => {});
console.log("data+readable", String(s.readableFlowing));
s.resume();
console.log("resume", String(s.readableFlowing));
s.pause();
console.log("pause", String(s.readableFlowing));
s.destroy();

const t = new net.Socket();
t.on("readable", () => {});
t.on("data", () => {});
console.log("readable+data", String(t.readableFlowing));
t.destroy();
