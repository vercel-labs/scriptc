import { ProxyAgent, request } from "undici";

const dispatcher = new ProxyAgent(process.argv[2]);
try {
  const response = await request("http://origin.invalid/probe?q=1", { dispatcher });
  console.log(response.statusCode, await response.body.text());
} finally {
  await dispatcher.close();
}
