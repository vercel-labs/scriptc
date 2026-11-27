// connect({ localAddress, localPort }) bind failures: Node's error text
// names the local endpoint (the port only when the request gave one) and
// the failed socket still settles with 'error' then 'close', so repeated
// failures never retain the socket or its listeners.
import * as net from "node:net";

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};

type Case = { label: string; options: net.NetConnectOpts };

interface BindError extends Error {
  code?: string;
  errno?: number;
  syscall?: string;
  address?: string;
  port?: number;
}

const cases: Case[] = [
  // an IPv4 local address on the IPv6 socket the ::1 destination picks:
  // bind EINVAL, with no ":0" appended for an unrequested port
  { label: "family-mismatch", options: { port: 9, host: "::1", localAddress: "127.0.0.1", localPort: 0 } },
  // an address this host does not own: EADDRNOTAVAIL, port omitted
  { label: "unassigned", options: { port: 9, host: "192.0.2.9", localAddress: "192.0.2.1" } },
  // the same failure with a requested port: the text and the `port`
  // property name it
  { label: "unassigned-port", options: { port: 9, host: "192.0.2.9", localAddress: "192.0.2.1", localPort: 12345 } },
];

const TRIES = 5;
let index = 0;

// A write queued before the failure answers at the close, after the
// 'error' and 'close' events — Node's _writeGeneric at destroy time.
const writeProbe = (): void => {
  const client = net.connect({ port: 9, host: "::1", localAddress: "127.0.0.1" });
  client.on("error", () => say("write-probe", "error"));
  client.on("close", () => say("write-probe", "close"));
  client.write("queued", (err) => {
    say("write-probe", "write-cb", err === null || err === undefined ? "ok" : (err as BindError).code);
  });
  setTimeout(() => {
    say("write-probe", "after");
    console.log(out.join("\n"));
  }, 50);
};

const next = (): void => {
  if (index === cases.length) {
    writeProbe();
    return;
  }
  const entry = cases[index++];
  // five failed connects, none destroyed explicitly: each settles alone
  let remaining = TRIES;
  for (let i = 0; i < TRIES; i++) {
    const client = net.connect(entry.options);
    client.on("error", (err) => {
      if (i !== 0) return;
      const e = err as BindError;
      say(entry.label, JSON.stringify(e.message), e.code, e.errno, e.syscall, e.address, "port", e.port);
    });
    client.on("close", () => {
      if (--remaining === 0) {
        say(entry.label, "closes", TRIES);
        next();
      }
    });
  }
};

next();
