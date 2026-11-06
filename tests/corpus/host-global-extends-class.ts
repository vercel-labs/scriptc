// A class extending a Node global native code does not provide is an
// ordinary class value in every way a program can observe one: typeof, name,
// length, identity through an alias, the prototype/constructor pair,
// statics, and a second class extending it. Constructing either class is
// the host-global fence, so the unconstructible classes live in the branch
// a program only takes where the global exists.
// The corpus compile declares the global the way the program's own .d.ts
// does: Node 24 has WebSocket, native code does not provide it.
interface HostSocket {
  readonly readyState: number;
}
declare var WebSocket: { new (url: string): HostSocket; readonly prototype: HostSocket };

const runsHere = process.versions.bun !== undefined;

class CodexSocket extends WebSocket {
  readonly label: string;
  private attempts = 0;
  static readonly OPEN_CODE = 1;
  constructor(url: string, label: string) {
    super(url);
    this.label = label;
  }
  retry(): void {
    this.attempts++;
  }
  static describe(url: string): string {
    return `socket:${url}`;
  }
}

class RetryingSocket extends CodexSocket {}

const Alias = CodexSocket;
const picked = runsHere ? CodexSocket : null;
console.log(typeof CodexSocket, CodexSocket.name, CodexSocket.length);
console.log(Alias === CodexSocket, picked === null, CodexSocket !== (WebSocket as unknown));
console.log(CodexSocket.prototype.constructor === CodexSocket);
console.log(CodexSocket.OPEN_CODE, CodexSocket.describe("ws://localhost:1"));
console.log(typeof RetryingSocket, RetryingSocket.name);
console.log(RetryingSocket !== CodexSocket, typeof CodexSocket === typeof RetryingSocket);
