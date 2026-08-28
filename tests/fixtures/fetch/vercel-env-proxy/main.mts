// @dynamic
// Vercel installs this dispatcher when ordinary proxy environment variables
// are present, without requiring Node's global NODE_USE_ENV_PROXY opt-in.
import { EnvProxyDispatcher } from "vercel-env-proxy-dispatcher";

declare global {
  interface RequestInit {
    dispatcher?: EnvProxyDispatcher;
  }
}

const response = await fetch(`${process.argv[2]}/text`, {
  dispatcher: new EnvProxyDispatcher(),
});
const body: string = await response.text();
console.log(body);
