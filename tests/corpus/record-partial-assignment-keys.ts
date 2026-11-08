// A record literal asserted to a wider record type keeps the fields a
// program assigns afterwards: the view holds each property the literal
// never wrote, so keys, JSON, reads and `in` answer as they do in Node.
type SettingKey = "alpha" | "bravo" | "charlie" | "delta" | "echo" | "foxtrot" | "golf" | "hotel";
const SETTING_KEYS: SettingKey[] = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
];
const settings = {
  alpha: null,
  bravo: null,
  charlie: null,
  delta: null,
  echo: null,
  foxtrot: null,
} as Record<SettingKey, string | null>;

console.log("start keys", Object.keys(settings).join(","));
console.log("start json", JSON.stringify(settings));

for (const key of SETTING_KEYS) settings[key] = key.toUpperCase();

console.log("keys", Object.keys(settings).join(","));
console.log("count", Object.keys(settings).length);
console.log("json", JSON.stringify(settings));
console.log("values", Object.values(settings).join("|"));
console.log("entries", Object.entries(settings).length);

console.log("has", "golf" in settings, "alpha" in settings, "zulu" in settings);
console.log("read", settings["golf"], settings.alpha, typeof settings.delta);

// Rewriting a key the literal wrote, and one it did not, keeps the order in
// which the object gained its properties.
for (const key of ["hotel", "alpha", "golf"] as SettingKey[]) settings[key] = null;
console.log("order", Object.keys(settings).join(","));
console.log("rewritten", JSON.stringify(settings));
console.log("rewritten read", settings["golf"], settings.alpha);
console.log("unwritten", settings.hotel ?? "empty");

function summarize(values: Record<SettingKey, string | null>): string {
  return `${Object.keys(values).length}:${values.golf ?? "-"}`;
}
console.log("summarize", summarize(settings));
