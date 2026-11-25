// A close() right after bindSync()/connectSync() suppresses the pending
// 'listening'/'connect' emissions, Node's null-handle check, while the
// 'close' event still fires.
import * as dgram from "node:dgram";

const bound: string[] = [];
const socket = dgram.createSocket("udp4");
socket.on("listening", () => bound.push("listening"));
socket.on("close", () => bound.push("close"));
socket.bindSync();
socket.close();
await new Promise<void>((resolve) => setTimeout(resolve, 10));
console.log("bindSync", bound.join(","));

const connected: string[] = [];
const client = dgram.createSocket("udp4");
client.on("connect", () => connected.push("connect"));
client.on("close", () => connected.push("close"));
client.connectSync(9, "127.0.0.1");
client.close();
await new Promise<void>((resolve) => setTimeout(resolve, 10));
console.log("connectSync", connected.join(","));
