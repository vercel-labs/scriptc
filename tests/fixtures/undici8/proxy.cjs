const { EnvHttpProxyAgent, request } = require("undici");

async function main() {
  const dispatcher = new EnvHttpProxyAgent({ httpProxy: process.argv[2], noProxy: "" });
  try {
    const response = await request("http://origin.invalid/probe?q=1", { dispatcher });
    console.log(response.statusCode, await response.body.text());
  } finally {
    await dispatcher.close();
  }
}

main();
