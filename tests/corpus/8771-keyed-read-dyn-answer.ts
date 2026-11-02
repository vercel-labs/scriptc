// A `keyof` read whose answer union collapses to the checked-dynamic
// representation (an 'object'-flavored arm) dispatches over the declared
// keys and answers a checked-dynamic value.
interface Settings {
  theme?: string;
  retry?: { enabled?: boolean; maxRetries?: number };
  levels?: { [key: string]: string };
  terminal?: object;
  lines?: number | string;
}

const loaded: Settings = {
  theme: "dark",
  retry: { enabled: true, maxRetries: 3 },
  terminal: { cols: 80 },
  lines: 40,
};

function report(settings: Settings, fields: Set<keyof Settings>): void {
  for (const field of fields) {
    const value = settings[field];
    if (value === undefined) {
      console.log(field, "missing");
    } else if (typeof value === "object" && value !== null) {
      console.log(field, "object", JSON.stringify(value));
    } else {
      console.log(field, typeof value, String(value));
    }
  }
}

report(loaded, new Set<keyof Settings>(["theme", "retry", "terminal", "lines", "levels"]));
const empty: Settings = {};
report(empty, new Set<keyof Settings>(["theme", "retry", "levels"]));
