import { Ts7Api } from "./api.js";
import { checkerReadsLibrariesFromDisk } from "./checker-features.js";
import { checkerServerName } from "./checker-server.js";
import { attachNativeTs7Process, spawnNativeTs7Wire } from "./native-process.js";
import { Ts7RpcClient } from "./rpc-client.js";
import type { Ts7FileSystem } from "./rpc-filesystem.js";
import { Ts7Wire } from "./rpc-wire.js";

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
      return new Ts7Api(rpc, options.fs, timing);
    } catch {
      rpc.close();
    }
  }
  return new Ts7Api(
    new Ts7RpcClient(spawnNativeTs7Wire(options.executable, options.cwd, timing, libraries)),
    options.fs,
    timing,
  );
}
