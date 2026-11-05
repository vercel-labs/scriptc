import type { Ts7ConfigData } from "./session-schema.generated.js";
import type { Ts7TimingInfo } from "./session-timing.js";
import { Ts7RpcClient } from "./rpc-client.js";
import { registerTs7FileSystem, type Ts7FileSystem } from "./rpc-filesystem.js";
import { Ts7Session, type Ts7SessionSnapshot, type Ts7Update } from "./session.js";

/** The same session API runs in Node and in the native compiler. Its caller
 * transfers ownership of a connected RPC client; closing the API closes
 * that client and its server transport. */
export class Ts7Api {
  private readonly session: Ts7Session;

  constructor(rpc: Ts7RpcClient, fs: Ts7FileSystem, collectTiming = false) {
    try {
      const session = new Ts7Session(rpc, collectTiming);
      // Callbacks run inside requests, after initialize chose the protocol.
      registerTs7FileSystem(rpc, fs, () => session.speaksTs71());
      this.session = session;
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  parseConfigFile(file: string): Ts7ConfigData {
    return this.session.parseConfigFile(file);
  }
  updateSnapshot(params: Ts7Update = {}): Ts7SessionSnapshot {
    return this.session.updateSnapshot(params);
  }
  getTimingInfo(): Ts7TimingInfo {
    return this.session.getTimingInfo();
  }
  close(): void {
    this.session.close();
  }
}
