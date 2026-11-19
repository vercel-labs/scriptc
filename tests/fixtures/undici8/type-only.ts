import undici, { type ProxyAgent } from "undici";

type ProxyConstructor = typeof undici.ProxyAgent;

function get(url: string, options?: ProxyAgent.Options, _ctor?: ProxyConstructor) {
  return undici.request(url, { method: options ? "POST" : "GET" });
}

const res = await get(process.argv[2]! + "/read");
console.log(res.statusCode, await res.body.text());
