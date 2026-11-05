/* node:dgram — UDP sockets over the event loop (scr_dgram.c, linked only
 * into using binaries). createSocket takes "udp4" or the
 * { type: "udp4", reuseAddr? } literal; bind/connect bind NOW and defer
 * 'listening'/'connect' to the next loop turn; send takes one string or
 * Buffer datagram with an explicit port + address (the connected-send
 * and callback forms have no lowering); address() returns the real
 * {address, family, port} record and THROWS "Not running" before bind,
 * like Node. The socket options throw Node's errors (EBADF before bind);
 * add/dropMembership before bind is refused at run time (SC2020). 'error'
 * with no listener exits 1 (the unhandled EventEmitter 'error' behavior). */
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
  export interface Socket {
    bind(port: number, address?: string, callback?: () => void): void;
    connect(port: number, address?: string, callback?: () => void): void;
    send(msg: string | Uint8Array, port: number, address: string): void;
    address(): AddressInfo;
    close(callback?: () => void): void;
    disconnect(): void;
    unref(): void;
    ref(): void;
    setBroadcast(flag: boolean): void;
    setTTL(ttl: number): number;
    setMulticastTTL(ttl: number): number;
    setMulticastLoopback(flag: boolean): boolean;
    setMulticastInterface(multicastInterface: string): void;
    addMembership(multicastAddress: string, multicastInterface?: string): void;
    dropMembership(multicastAddress: string, multicastInterface?: string): void;
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
  }
  export function createSocket(type: "udp4"): Socket;
  export function createSocket(options: { type: "udp4"; reuseAddr?: boolean }): Socket;
}

declare module "node:dgram" {
  export * from "dgram";
}
