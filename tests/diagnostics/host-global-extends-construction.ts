// Constructing a class that extends a Node global native code does not
// provide is the host-global fence at the construction: the class's super()
// reaches the constructor value's SC2020 throw, so native code can never
// produce an instance — not the subclass's, not a further subclass's.
interface HostSocket {
  readonly readyState: number;
}
declare var WebSocket: { new (url: string): HostSocket; readonly prototype: HostSocket };

class Sock extends WebSocket {
  constructor(url: string) {
    super(url);
  }
}
class Retrying extends Sock {}
const sock = new Sock("ws://localhost:1");
const retrying = new Retrying("ws://localhost:2");
console.log(sock, retrying);
