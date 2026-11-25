// An empty object literal asserted to a record type is a view with no
// fields; every property the program assigns afterwards is added to it, in
// the order the assignments happen.
type Flag = "retry" | "fast" | "slow" | "once";
const FLAGS: Flag[] = ["retry", "fast", "slow"];
const options = {} as Record<Flag, string | null>;

console.log("empty keys", Object.keys(options).join(","));
console.log("empty json", JSON.stringify(options));

for (const flag of FLAGS) options[flag] = `${flag}!`;

console.log("keys", Object.keys(options).join(","));
console.log("json", JSON.stringify(options));
console.log("has", FLAGS.length, "once" in options, "slow" in options);
console.log("read", options.slow, options["fast"]);

// A field the empty literal never wrote still takes a value, including null.
options.once = null;
console.log("null-out", options.once === null, "once" in options);

function collect(values: Record<Flag, string | null>): string {
  const parts: string[] = [];
  for (const key of Object.keys(values) as Flag[]) parts.push(`${key}=${values[key]}`);
  return parts.join(",");
}
console.log("collect", collect(options));
