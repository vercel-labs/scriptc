// A `keyof` read over a record that holds an `unknown` member: the
// checker's answer collapses to `unknown` (the union of every field type
// absorbs into it), so there is no typed join. The read dispatches per
// declared key through the checked-dynamic slot instead.
interface Retry {
  baseDelayMs?: number;
  enabled?: boolean;
}
interface Settings {
  $schema?: string;
  enabledModels?: string[];
  branchSummary: unknown;
  fullscreenWheelScrollLines?: number | string;
  modelThinkingLevels?: { [key: string]: string };
  retry?: Retry;
  outputPad?: number;
}
function read(settings: Settings, key: keyof Settings): unknown {
  return settings[key];
}
const settings: Settings = {
  branchSummary: { note: "x", count: 2 },
  outputPad: 4,
  enabledModels: ["m"],
  fullscreenWheelScrollLines: "wide",
  modelThinkingLevels: { high: "big" },
  retry: { enabled: true },
};
const keys: (keyof Settings)[] = [
  "outputPad",
  "enabledModels",
  "branchSummary",
  "retry",
  "$schema",
  "fullscreenWheelScrollLines",
];
for (const key of keys) {
  const value = read(settings, key);
  console.log(key, typeof value, value === undefined ? "absent" : JSON.stringify(value));
}
