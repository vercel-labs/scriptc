import { type ProxyAgent, request } from "undici";

function get(url: string, options?: ProxyAgent.Options) {
  return request(url, { method: options ? "POST" : "GET" });
}

const res = await get(process.argv[2]! + "/read");
console.log(res.statusCode, await res.body.text());
