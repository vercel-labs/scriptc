// undici 7.x's EnvHttpProxyAgent (lib/dispatcher/env-http-proxy-agent.js):
// a dispatcher that picks, per request, between one Agent that goes
// straight at the origin and a ProxyAgent per scheme, from the proxy
// settings the constructor gives or the environment holds. NO_PROXY lists
// the hosts that bypass the proxy; each entry is a hostname, an optional
// `:port`, and `*` alone means never proxy.
//
// The agent the request takes is decided from the request origin's host
// and port exactly as undici decides it, including the IPv6 brackets and
// the scheme's default port. `noProxy` given to the constructor is fixed;
// without it, the environment is re-read on every request, so a program
// that changes NO_PROXY changes the routing.
import { Agent } from "./agent.ts";
import { Dispatcher, DispatcherBase } from "./dispatcher.ts";
import { ProxyAgent, type ProxyAgentOptions } from "./proxy-agent.ts";
import type { DispatchHandlers, DispatchOptions, Profile } from "./types.ts";

/** undici's EnvHttpProxyAgent.Options. */
export interface EnvHttpProxyAgentOptions extends Omit<ProxyAgentOptions, "uri"> {
  /** Overrides http_proxy / HTTP_PROXY. */
  httpProxy?: string;
  /** Overrides https_proxy / HTTPS_PROXY. */
  httpsProxy?: string;
  /** Overrides no_proxy / NO_PROXY. */
  noProxy?: string;
}

interface NoProxyEntry {
  hostname: string;
  port: number;
}

const DEFAULT_PORTS: ReadonlyMap<string, number> = new Map([
  ["http:", 80],
  ["https:", 443],
]);

function envValue(name: string): string | null {
  const value = process.env[name];
  return value === undefined ? null : value;
}

export class EnvHttpProxyAgent extends DispatcherBase {
  __noProxyAgent: Dispatcher;
  __httpProxyAgent: Dispatcher;
  __httpsProxyAgent: Dispatcher;
  __noProxyValue: string;
  __noProxyEntries: NoProxyEntry[];
  __fixedNoProxy: string | undefined;
  __envNoProxy: string;

  constructor(options: EnvHttpProxyAgentOptions, profile: Profile) {
    super(profile);
    const opts: EnvHttpProxyAgentOptions = options ?? {};
    // Everything but the three environment members belongs to the agents
    // this dispatcher builds, ProxyAgent's requestTls and proxyTls
    // included: a configured private trust store must reach the tunnel,
    // never be replaced by the system roots.
    const { httpProxy, httpsProxy, noProxy, ...agentOptions } = opts;
    this.__noProxyAgent = new Agent(agentOptions, profile);
    const http = httpProxy ?? envValue("http_proxy") ?? envValue("HTTP_PROXY");
    this.__httpProxyAgent =
      http !== null && http !== ""
        ? new ProxyAgent({ ...agentOptions, uri: http }, profile, (o) => new Agent(o, profile))
        : this.__noProxyAgent;
    const https = httpsProxy ?? envValue("https_proxy") ?? envValue("HTTPS_PROXY");
    this.__httpsProxyAgent =
      https !== null && https !== ""
        ? new ProxyAgent({ ...agentOptions, uri: https }, profile, (o) => new Agent(o, profile))
        : this.__httpProxyAgent;
    this.__fixedNoProxy = noProxy;
    this.__envNoProxy = "";
    this.__noProxyValue = "";
    this.__noProxyEntries = [];
    this.__parseNoProxy();
  }

  __dispatch(options: DispatchOptions, handler: DispatchHandlers): boolean {
    const origin = options.origin;
    const url = new URL(origin === undefined ? "" : String(origin));
    const agent = this.__agentForURL(url);
    return agent.dispatch(options, handler);
  }

  __close(): Promise<void> {
    const agents: Dispatcher[] = [];
    const add = (agent: Dispatcher): void => {
      if (!agents.includes(agent)) agents.push(agent);
    };
    add(this.__noProxyAgent);
    add(this.__httpProxyAgent);
    add(this.__httpsProxyAgent);
    return Promise.all(agents.map((agent) => agent.close())).then(() => undefined);
  }

  __destroy(err: Error): Promise<void> {
    const agents: Dispatcher[] = [];
    const add = (agent: Dispatcher): void => {
      if (!agents.includes(agent)) agents.push(agent);
    };
    add(this.__noProxyAgent);
    add(this.__httpProxyAgent);
    add(this.__httpsProxyAgent);
    return Promise.all(agents.map((agent) => agent.destroy(err))).then(() => undefined);
  }

  __agentForURL(url: URL): Dispatcher {
    let hostname = url.host.replace(/:\d*$/, "").toLowerCase();
    const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS.get(url.protocol) || 0;
    if (!this.__shouldProxy(hostname, port)) return this.__noProxyAgent;
    if (url.protocol === "https:") return this.__httpsProxyAgent;
    return this.__httpProxyAgent;
  }

  __shouldProxy(hostname: string, port: number): boolean {
    if (this.__fixedNoProxy === undefined && this.__noProxyValue !== this.__currentNoProxy()) {
      this.__parseNoProxy();
    }
    if (this.__noProxyEntries.length === 0) return true;
    if (this.__noProxyValue === "*") return false;
    for (const entry of this.__noProxyEntries) {
      if (entry.port !== 0 && entry.port !== port) continue;
      if (hostname === entry.hostname) return false;
      if (hostname.endsWith(`.${entry.hostname}`)) return false;
    }
    return true;
  }

  __currentNoProxy(): string {
    this.__envNoProxy = envValue("no_proxy") ?? envValue("NO_PROXY") ?? "";
    return this.__envNoProxy;
  }

  __parseNoProxy(): void {
    const value = this.__fixedNoProxy !== undefined ? this.__fixedNoProxy : this.__currentNoProxy();
    const entries: NoProxyEntry[] = [];
    for (const raw of value.split(/[,\s]/)) {
      if (raw === "") continue;
      const parsed = /^(.+):(\d+)$/.exec(raw);
      const host = parsed === null ? raw : parsed[1]!;
      const port = parsed === null ? 0 : Number.parseInt(parsed[2]!, 10);
      entries.push({ hostname: host.replace(/^\*?\./, "").toLowerCase(), port });
    }
    this.__noProxyValue = value;
    this.__noProxyEntries = entries;
  }
}
