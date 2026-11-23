/* node:dgram — UDP sockets over the event loop (scr_dgram.c, linked only
 * into using binaries). udp4 and udp6; createSocket and `new Socket` take
 * the bare type string or the options record (type, reuseAddr, ipv6Only,
 * reusePort, recvBufferSize, sendBufferSize), with the message listener as
 * the second argument. bind/connect bind NOW and defer 'listening'/
 * 'connect' to the next loop turn; bindSync/connectSync do the same
 * synchronously and throw their failures; send takes one string or Buffer
 * datagram with an explicit port + address (the connected-send and
 * callback forms ride the checked-dynamic ladder). bind(options) adopts an
 * existing datagram descriptor when options.fd is a positive int32 (any
 * other fd falls through to the port bind; bindSync ignores fd). address() and
 * remoteAddress() return the real {address, family, port} record and
 * THROW Node's state errors ("Not running" after close(), getsockname's
 * EBADF before bind, ERR_SOCKET_DGRAM_NOT_CONNECTED for remoteAddress()).
 * The socket options throw Node's errors (EBADF before bind);
 * add/dropMembership implicitly binds an unbound socket, like Node.
 * 'error' with no listener exits 1 (the unhandled EventEmitter 'error'
 * behavior). receiveBlockList drops packets from a blocked source before
 * they reach 'message'; sendBlockList makes a blocked send fail its
 * callback with ERR_IP_BLOCKED and never reach the wire; createSocket's
 * signal closes the socket when it aborts. A custom `lookup` runs for
 * bind, connect and the unconnected sends, as Node's handle lookup does. */
declare module "dgram" {
  export interface AddressInfo {
    address: string;
    family: string;
    port: number;
  }
  export interface RemoteInfo {
    address: string;
    family: string;
    port: number;
    size: number;
  }
  export interface BindOptions {
    port?: number;
    address?: string;
    exclusive?: boolean;
    /** An existing datagram descriptor to adopt (bind); bindSync ignores it. */
    fd?: number;
  }
  export interface SocketOptions {
    type: "udp4" | "udp6";
    reuseAddr?: boolean;
    ipv6Only?: boolean;
    reusePort?: boolean;
    recvBufferSize?: number;
    sendBufferSize?: number;
    signal?: AbortSignal;
    /** Node's handle-lookup contract: the address, the socket family (4 or
     * 6), and a callback taking an error or the resolved IP. */
    lookup?: (
      address: string,
      family: number,
      callback: (error: Error | null, ip: string) => void,
    ) => void;
    receiveBlockList?: import("net").BlockList;
    sendBlockList?: import("net").BlockList;
  }
  export interface Socket {
    type: "udp4" | "udp6";
    bind(port?: number, address?: string, callback?: () => void): void;
    bind(port: number, callback: () => void): void;
    bind(options: BindOptions, callback?: () => void): void;
    bindSync(options?: BindOptions): AddressInfo;
    connect(port: number, address?: string, callback?: () => void): void;
    connect(port: number, callback: () => void): void;
    connectSync(port: number, address?: string): void;
    disconnect(): void;
    /* Node's send ladder: one datagram or a list of chunks, a connected
     * send, the offset/length slice, and the completion callback in any of
     * its positions. */
    send(
      msg: string | Uint8Array | readonly unknown[],
      port?: number,
      address?: string,
      callback?: (error: Error | null, bytes: number) => void,
    ): void;
    send(
      msg: string | Uint8Array | readonly unknown[],
      port?: number,
      callback?: (error: Error | null, bytes: number) => void,
    ): void;
    send(
      msg: string | Uint8Array | readonly unknown[],
      callback?: (error: Error | null, bytes: number) => void,
    ): void;
    send(
      msg: string | Uint8Array,
      offset: number,
      length: number,
      port?: number,
      address?: string,
      callback?: (error: Error | null, bytes: number) => void,
    ): void;
    send(
      msg: string | Uint8Array,
      offset: number,
      length: number,
      port?: number,
      callback?: (error: Error | null, bytes: number) => void,
    ): void;
    send(
      msg: string | Uint8Array,
      offset: number,
      length: number,
      callback?: (error: Error | null, bytes: number) => void,
    ): void;
    address(): AddressInfo;
    remoteAddress(): AddressInfo;
    close(callback?: () => void): void;
    unref(): void;
    ref(): void;
    setBroadcast(flag: boolean): void;
    setTTL(ttl: number): number;
    setMulticastTTL(ttl: number): number;
    setMulticastLoopback(flag: boolean): boolean;
    setMulticastInterface(multicastInterface: string): void;
    addMembership(multicastAddress: string, multicastInterface?: string): void;
    dropMembership(multicastAddress: string, multicastInterface?: string): void;
    addSourceSpecificMembership(
      sourceAddress: string,
      groupAddress: string,
      multicastInterface?: string,
    ): void;
    dropSourceSpecificMembership(
      sourceAddress: string,
      groupAddress: string,
      multicastInterface?: string,
    ): void;
    getRecvBufferSize(): number;
    getSendBufferSize(): number;
    setRecvBufferSize(size: number): void;
    setSendBufferSize(size: number): void;
    getSendQueueSize(): number;
    getSendQueueCount(): number;
    on(event: "message", listener: (msg: Buffer, rinfo: RemoteInfo) => void): void;
    on(event: "listening" | "close" | "connect", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    once(event: "message", listener: (msg: Buffer, rinfo: RemoteInfo) => void): void;
    once(event: "listening" | "close" | "connect", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    [Symbol.asyncDispose](): Promise<void>;
  }
  /** The class value createSocket builds: `new dgram.Socket(type | options[,
   * listener])` and `x instanceof dgram.Socket`. */
  export const Socket: {
    new (type: "udp4" | "udp6", listener?: (msg: Buffer, rinfo: RemoteInfo) => void): Socket;
    new (options: SocketOptions, listener?: (msg: Buffer, rinfo: RemoteInfo) => void): Socket;
  };
  /** Any string is accepted: a value that is not "udp4" or "udp6" throws
   * Node's ERR_SOCKET_BAD_TYPE at run time, as a non-literal type does in
   * JavaScript. */
  export function createSocket(
    type: string,
    callback?: (msg: Buffer, rinfo: RemoteInfo) => void,
  ): Socket;
  export function createSocket(
    options: SocketOptions,
    callback?: (msg: Buffer, rinfo: RemoteInfo) => void,
  ): Socket;
}

declare module "node:dgram" {
  export * from "dgram";
}
