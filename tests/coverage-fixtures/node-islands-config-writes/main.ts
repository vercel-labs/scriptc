// A package the automatic island policy runs in Node types its values by its
// declarations: the config object's members are written one by one (an SDK
// client config), which is a dynamic property write on the island's handle,
// not "assignment to non-variables".
import { createClient } from "ni-config";
import type { ClientConfig } from "ni-config";

const config: ClientConfig = { profile: "p" };
config.endpoint = "http://127.0.0.1:9";
config.region = "eu-west-1";
config.requestHandler = { handle() {} };
config.token = { token: "t" };
console.log(config.profile, config.region, createClient(config).region());
