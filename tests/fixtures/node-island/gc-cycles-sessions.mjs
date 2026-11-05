// A program module the island half of gc-cycles.mjs imports too (a shared
// module, scope-B NI-6): native sessions paired with island peers.
export class Session {
  constructor(id) {
    this.id = id;
    this.peer = null;
  }
  send(text) {
    return this.peer ? this.peer.receive(text) : 0;
  }
}
const open = [];
export function keep(session) {
  open.push(session);
}
export function openSessions() {
  return open;
}
