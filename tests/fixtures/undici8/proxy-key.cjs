const undici = require("undici");

async function main() {
  if (!("EnvHttpProxyAgent" in undici)) throw new Error("missing proxy agent");
  const dispatcher = new undici["EnvHttpProxyAgent"]({ httpProxy: process.argv[2], noProxy: "" });
  try {
    const response = await undici.request("http://origin.invalid/probe?q=1", { dispatcher });
    console.log(response.statusCode, await response.body.text());
  } finally {
    await dispatcher.close();
  }
}

main();
