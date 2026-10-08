// `in` with a RUNTIME string key over an INDEX-SIGNATURE record — the
// service-config idiom (`names.filter((k) => k in config)`): the interned
// %rec.haskey helper answers declared names statically per name (optional
// slots by their runtime presence) and then walks the overflow map's live
// keys.
interface Seed {
  tokens?: Record<string, string>;
  [service: string]: unknown;
}

const NAMES = ["vercel", "github", "google", "slack"] as const;
type Name = (typeof NAMES)[number];
const LIST: readonly Name[] = NAMES;

const config: Seed = { github: { users: 1 }, slack: {} };
console.log(LIST.filter((k) => k in config).join(","));

// Runtime inserts join the overflow walk (a null VALUE is still present).
config["vercel"] = null;
console.log(LIST.filter((k) => k in config).join(","));

// The declared OPTIONAL field answers per value: absent here...
console.log("tokens" in config);
// ...present there.
const withTokens: Seed = { tokens: { a: "b" }, extra: 1 };
console.log("tokens" in withTokens);

// A computed (concatenated) key — no literal to fold.
const key: string = "ext" + "ra";
console.log(key in withTokens, key in config);
