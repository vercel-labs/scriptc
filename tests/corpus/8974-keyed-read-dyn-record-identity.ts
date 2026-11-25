// A dynamic keyed read that answers a checked-dynamic value hands back the
// field itself: the result is the same object, and a write through it is
// visible in the settings record.
interface Settings {
  theme?: string;
  retry?: { enabled?: boolean; maxRetries?: number };
  levels?: { [key: string]: string };
  terminal?: object;
  lines?: number | string;
  list?: string[];
  pair?: [string, string];
}

function read(settings: Settings, field: keyof Settings): any {
  return settings[field];
}

const settings: Settings = {
  theme: "dark",
  retry: { enabled: false, maxRetries: 1 },
  levels: { a: "1" },
  terminal: { cols: 80 },
  lines: 40,
  list: ["a"],
  pair: ["x", "y"],
};

const retry = read(settings, "retry");
console.log("retry is the field:", retry === settings.retry);
retry.enabled = true;
retry.maxRetries = 30;
console.log("retry:", settings.retry!.enabled, settings.retry!.maxRetries);

const levels = read(settings, "levels");
console.log("levels is the field:", levels === settings.levels);
levels.b = "2";
console.log("levels:", settings.levels!.b, settings.levels!.a);

const list = read(settings, "list");
console.log("list is the field:", list === settings.list, Array.isArray(list));
list.push("b");
list[0] = "z";
console.log("list:", settings.list!.length, settings.list![0]);

const pair = read(settings, "pair");
console.log("pair is the field:", pair === settings.pair, Array.isArray(pair));
pair[0] = "w";
console.log("pair:", settings.pair![0]);

const terminal = read(settings, "terminal");
terminal.cols = 120;
console.log("terminal:", (settings.terminal as any).cols);

console.log("scalars:", read(settings, "lines"), read(settings, "theme"));
const empty: Settings = {};
console.log("missing:", read(empty, "retry") === undefined, read(empty, "theme") === undefined);
