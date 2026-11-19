// @ts-nocheck
import { ProxyAgent, request } from "und\u0069ci";

const dispatcher = new ProxyAgent(process.argv[2]);
try {
  const response = await request("http://origin.invalid/probe?q=1", { dispatcher });
  console.log(response.statusCode, await response.body.text());
} finally {
  await dispatcher.close();
}
