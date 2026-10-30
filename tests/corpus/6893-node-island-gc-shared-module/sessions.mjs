// A program module island code imports too (shared, scope-B NI-6): native
// sessions that island code pairs with island peers.
export class Session {
  constructor(id) {
    this.id = id;
    this.peer = null;
    this.log = [];
  }
  send(text) {
    this.log.push(text);
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
