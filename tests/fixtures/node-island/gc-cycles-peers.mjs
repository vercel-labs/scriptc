// Island code for gc-cycles.mjs: island peers paired with native sessions
// of a shared module, each pair a cycle across both heaps.
import { keep, Session } from "./gc-cycles-sessions.mjs";

class Peer {
  constructor(session) {
    this.session = session;
    this.received = 0;
    this.payload = new Array(64).fill(1);
  }
  receive(text) {
    this.received += text.length;
    return this.received;
  }
}

export function pair(id, keepIt) {
  const session = new Session(id);
  session.peer = new Peer(session);
  const n = session.send(`hello ${id}`);
  if (keepIt) keep(session);
  return n;
}
