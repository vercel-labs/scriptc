// The hot-shots 8.x shim for installations with the optional unix-dgram
// addon: the uds protocol sends through a native Unix datagram socket.
import { configureUnixDgram } from "./client.ts";

configureUnixDgram(true);

export * from "./client.ts";
export { default } from "./client.ts";
