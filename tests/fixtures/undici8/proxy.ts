import { EnvHttpProxyAgent, ProxyAgent, request } from "undici";

const proxy = process.argv[2]!;
const explicit = new ProxyAgent(proxy);
const fromEnv = new EnvHttpProxyAgent({ httpProxy: proxy, noProxy: "" });
try {
  for (const dispatcher of [explicit, fromEnv]) {
    const response = await request("http://origin.invalid/probe?q=1", { dispatcher });
    console.log(response.statusCode, await response.body.text());
  }
} finally {
  await explicit.close();
  await fromEnv.close();
}
