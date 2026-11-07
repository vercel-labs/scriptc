// A static a class inherits from a Node global native code does not provide
// is that global's own surface. Reading or calling it through the subclass,
// or through a class extending the subclass, is the host-global fence the
// same read off the global reports, never undefined. The statics the
// program's own classes declare keep their lowering; one declared in a form
// that has none (an accessor) names the member, since the class value does
// not carry it either.
interface HostSocket {
  readonly readyState: number;
}
declare var WebSocket: {
  new (url: string): HostSocket;
  readonly prototype: HostSocket;
  readonly OPEN: number;
  probe(url: string): boolean;
};

class Sock extends WebSocket {
  static readonly RETRIES = 3;
  static get label(): string {
    return "sock";
  }
  constructor(url: string) {
    super(url);
  }
}
class Retrying extends Sock {}
const Alias = Sock;
console.log(Sock.RETRIES, Retrying.RETRIES, Alias.RETRIES, Sock.name);
console.log(Sock.OPEN);
console.log(Retrying.OPEN);
console.log(Alias.OPEN);
console.log(Sock.probe("ws://localhost:1"));
console.log(Sock.label);
