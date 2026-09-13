// Object spread ignores undefined sources and guarded Object.entries receives the narrowed record.
function maybe(enabled: boolean): Record<string, string> | undefined {
  return enabled ? { b: "2" } : undefined;
}

const merged: Record<string, string> = { a: "1", ...maybe(false), ...maybe(true) };
console.log("merged", Object.keys(merged).join(","), merged.a, merged.b);

function describe(input?: Record<string, string>): string {
  if (!input) return "none";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) parts.push(`${key}=${value}`);
  return parts.join("|");
}
console.log("entries", describe(merged), describe(undefined));
