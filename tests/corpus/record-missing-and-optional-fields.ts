// A missing key of a `Record` and an optional field of a JSON-decoded object
// read as `undefined`, exactly as Node reads them: the looked-up property is
// absent, not a contradiction of the declared value type. Differentially vs
// Node.
const empty: Record<string, string> = {};
console.log("dot", empty["missing"], empty.missing, empty["missing"] === undefined);
const key = "missing";
console.log("computed", empty[key], empty[key] === undefined);
const spread = empty["missing"];
console.log("binding", spread, spread ?? "fallback");

function read(r: Record<string, number>): void {
  console.log("param", r["port"], r["port"] === undefined, r["port"] ?? -1);
}
read({});

interface Config {
  name?: string;
  verbose?: boolean;
  port?: number;
}
const config = JSON.parse('{"verbose":true}') as Config;
console.log("optional", config.name, config.verbose, config.port);
console.log("guarded", config.name === undefined);
const { name = "default", port = 0 } = config;
console.log("defaults", name, port, config.name ?? "none");
console.log("chain", config.name?.length);

// A present value is unchanged.
const full: Record<string, string> = { present: "here" };
console.log("present", full["present"], full["present"].length);
