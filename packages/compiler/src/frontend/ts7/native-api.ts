import { Ts7Api } from "./api.js";
import { checkerReadsLibrariesFromDisk } from "./checker-features.js";
import { checkerServerName } from "./checker-server.js";
import { attachNativeTs7Process, spawnNativeTs7Wire } from "./native-process.js";
import { Ts7RpcClient } from "./rpc-client.js";
import type { Ts7FileSystem } from "./rpc-filesystem.js";
import { Ts7Wire, type Ts7WireIo } from "./rpc-wire.js";

let sharedServerLost = false;

/** Whether a connection to the shared checker server failed in this process
 * after the server answered: a transfer failed or the server ended the
 * connection. The build then runs again with its own checker (cli.ts). */
export function checkerServerLost(): boolean {
  return sharedServerLost;
}

/** `io`, recording a failed transfer or an ended stream in sharedServerLost. */
function watched(io: Ts7WireIo): Ts7WireIo {
  return {
    read: (buffer, offset, length) => {
      try {
        const count = io.read(buffer, offset, length);
        if (count === 0) sharedServerLost = true;
        return count;
      } catch (error) {
        sharedServerLost = true;
        throw error;
      }
    },
    write: (buffer, offset, length) => {
      try {
        return io.write(buffer, offset, length);
      } catch (error) {
        sharedServerLost = true;
        throw error;
      }
    },
    close: () => io.close(),
  };
}

/** The native driver supplies its installed TypeScript executable path.
 * Package discovery is separate from starting and owning a server. */
export function createNativeTs7Api(options: {
  executable: string;
  cwd: string;
  fs: Ts7FileSystem;
  collectTiming?: boolean;
  shared?: boolean;
}): Ts7Api {
  const timing = options.collectTiming ?? false;
  // The checker reads its own library files when it can: they are part of the
  // installed tsc-ts, so no build serves them differently.
  const libraries = checkerReadsLibrariesFromDisk(options.executable);
  const server =
    options.shared === false
      ? null
      : checkerServerName(options.executable, options.cwd, timing, process.env, libraries);
  const shared =
    server === null
      ? null
      : attachNativeTs7Process(server, options.executable, options.cwd, timing, libraries);
  if (shared !== null) {
    const rpc = new Ts7RpcClient(new Ts7Wire(shared));
    try {
      // A server that ended the connection leaves this build to start its own.
      rpc.requestText("ping", "null");
    } catch {
      rpc.close();
      return new Ts7Api(
        new Ts7RpcClient(spawnNativeTs7Wire(options.executable, options.cwd, timing, libraries)),
        options.fs,
        timing,
      );
    }
    return new Ts7Api(new Ts7RpcClient(new Ts7Wire(watched(shared))), options.fs, timing);
  }
  return new Ts7Api(
    new Ts7RpcClient(spawnNativeTs7Wire(options.executable, options.cwd, timing, libraries)),
    options.fs,
    timing,
  );
}
