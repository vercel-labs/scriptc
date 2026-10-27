// Inside a generic body, `Object.entries(tags)` over `T extends
// Record<string, unknown>` reads `[string, T[keyof T]]` elements. An
// instance whose T is the unknown-valued record view reads every member
// as unknown; a record instance reads the union of its member types.
function upper(text: string): string {
  return text.toUpperCase();
}

function scrub(text: string): string {
  return text.replace(/secret/g, "***");
}

function describe<T extends Record<string, unknown>>(tags: T): string[] {
  return Object.entries(tags).map(
    ([key, value]) => `${key}=${typeof value === "string" ? upper(value) : String(value)}`,
  );
}

function redact<T extends Record<string, unknown>>(tags: T): T {
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [key, typeof value === "string" ? scrub(value) : value]),
  ) as T;
}

function flatten(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : { value };
}

console.log(describe(flatten({ b: 1, a: "x", c: true })));
console.log(describe(flatten(5)));
console.log(describe({ name: "n", size: 3 }));
const cleaned = redact(flatten({ token: "secret", count: 2 }));
console.log(cleaned, Object.keys(cleaned));
