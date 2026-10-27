// The hot-shots 8.x shim for installations without the optional unix-dgram
// addon: the uds protocol reports it missing, as hot-shots does under Node.
import { configureUnixDgram } from "./client.ts";

configureUnixDgram(false);

export * from "./client.ts";
export { default } from "./client.ts";
