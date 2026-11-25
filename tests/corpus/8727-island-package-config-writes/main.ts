// @requires-libnode
// A config object typed by a package that runs in a Node island: its optional
// members are written one by one, then the package reads them back, exactly as
// an AWS SDK client config is built (pi's bedrock provider).
import { createClient, retry } from "island-config-pkg";
import type { ClientConfig } from "island-config-pkg";

async function main(): Promise<void> {
  const config: ClientConfig = { profile: "profile-a" };
  config.endpoint = "http://127.0.0.1:9";
  config.region = "eu-west-1";
  config.requestHandler = { handle() {} };
  config.token = { token: "bearer" };
  console.log(config.profile, config.endpoint, config.region, typeof config.requestHandler);
  console.log(config.token?.token);

  const client = createClient(config);
  console.log(client.describe());

  const echoed = await retry(config, async () => config.region ?? "missing");
  console.log("retried", echoed);

  // A member read back in native code is dynamic too: the write above landed
  // on the island's object, not on a compile-time layout.
  const reread: ClientConfig = config;
  console.log("reread", reread.region, reread.requestHandler?.handle === undefined);
}

await main();
