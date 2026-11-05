// Island code: island peers paired with native sessions of the shared
// module, each pair a cycle across both heaps.
import { keep, Session } from "./sessions.mjs";

class Peer {
  constructor(session) {
    this.session = session;
    this.received = 0;
    this.payload = new Array(128).fill(1);
  }
  receive(text) {
    this.received += text.length;
    return this.received;
  }
}

export function pair(id, keepIt) {
  const session = new Session(id);
  const peer = new Peer(session);
  session.peer = peer;
  const n = session.send(`hello ${id}`);
  if (keepIt) keep(session);
  return n;
}

export function churn(kib) {
  let total = 0;
  for (let i = 0; i < kib; i++) total += new Array(128).fill(i).length;
  return total;
}
