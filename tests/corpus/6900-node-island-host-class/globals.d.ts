// The program declares the host class the way @types/node declares the
// WebSocket global: an interface plus a `var` of its constructor type. Only
// Node has the value itself.
interface HostSocket {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
}

declare var WebSocket: {
  new (url: string): HostSocket;
  readonly prototype: HostSocket;
};
