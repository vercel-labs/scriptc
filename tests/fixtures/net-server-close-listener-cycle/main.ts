// A settled server keeps its persistent 'close' listeners for the repeat
// emission a later close() causes. A listener that captures its own server
// then forms server → closure → server, an ownership cycle native handles
// stay outside of: unless the settle drops such a listener, every temporary
// server and everything it captured outlives its close until process exit.
// This program opens and closes short-lived servers in small waves (so only
// one wave's payloads are ever alive at once), each with a self-capturing
// 'close' listener and its own 32 KiB payload, and prints its resident size
// after the last one; tests/harness/net-server-close-listener-cycle.test.ts
// bounds it.
import * as net from "node:net";

const servers = 2000;
const waveSize = 100;
let opened = 0;
let settled = 0;
let payloadBytes = 0;

function one(index: number): void {
  const server = net.createServer();
  // Each server captures its own, differently sized payload, and its
  // listener reads the server back: a retained pair keeps both.
  const payload = "s".repeat(32 * 1024 - index);
  server.on("close", () => {
    settled += 1;
    payloadBytes += payload.length;
    // The capture itself: the listener asks its own server a state bit.
    if (server.listening) payloadBytes += 1;
    if (opened < servers) {
      // The next wave starts once this one has settled, so the program never
      // holds more than one wave's payloads at a time.
      if (settled % waveSize === 0) wave();
      return;
    }
    if (settled < servers) return;
    const rss = process.memoryUsage.rss();
    // 2000 retained pairs carry 2000 payloads of ~32 KiB, more than 60 MiB,
    // besides their server and listener; a bounded run stays well under this.
    const bounded = rss < 40 * 1024 * 1024;
    console.log("servers", settled, "payload", payloadBytes, bounded ? "rss under 40 MiB" : "rss over");
  });
  server.listen(0, "127.0.0.1", () => {
    server.close();
  });
}

function wave(): void {
  const end = Math.min(opened + waveSize, servers);
  while (opened < end) one(opened++);
}

wave();
