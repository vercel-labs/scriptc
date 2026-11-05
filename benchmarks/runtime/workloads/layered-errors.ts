// A configuration loader whose validation errors are thrown at the bottom
// of a stack of small layers and caught per entry at the top: each layer
// holds strings and arrays while the error passes through it.
class ConfigError extends Error {
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.key = key;
  }
}

let seed = 4242;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

function fail(key: string, text: string): never {
  throw new ConfigError(key, `invalid value "${text}" for ${key}`);
}
function digits(key: string, text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) fail(key, text);
    value = value * 10 + (c - 48);
  }
  return value;
}
function parseNumber(key: string, text: string): number {
  return text.length === 0 ? fail(key, text) : digits(key, text);
}
function checkRange(key: string, text: string, max: number): number {
  const value = parseNumber(key, text);
  return value > max ? fail(key, text) : value;
}
function coerce(key: string, raw: string, max: number): number {
  const trimmed = raw.trim();
  const parts = [key, trimmed];
  const value = checkRange(key, trimmed, max);
  return value + parts.length;
}
function resolveValue(key: string, raw: string, defaults: Map<string, string>): number {
  const text = raw === "default" ? (defaults.get(key) ?? "") : raw;
  const label = "value:" + key;
  return coerce(key, text, 100000) + label.length;
}
function loadEntry(section: string, entry: string, defaults: Map<string, string>): number {
  const eq = entry.indexOf("=");
  const key = section + "." + entry.slice(0, eq);
  const path = [section, key];
  return resolveValue(key, entry.slice(eq + 1), defaults) + path.length;
}
function loadEntryWithContext(section: string, entry: string, defaults: Map<string, string>): number {
  const context = `${section}/${entry.length}`;
  return loadEntry(section, entry, defaults) + context.length;
}

function makeEntry(i: number): string {
  const r = random();
  const name = "k" + (i % 97);
  if (r < 0.3) return `${name}=x${i}`;
  if (r < 0.4) return `${name}=`;
  if (r < 0.5) return `${name}=${200000 + i}`;
  if (r < 0.55) return `${name}=default`;
  return `${name}= ${Math.floor(random() * 90000)} `;
}

const rounds = Number(process.argv[2] ?? "1");
const defaults = new Map<string, string>();
for (let i = 0; i < 97; i += 2) defaults.set(`net.k${i}`, String(i * 10));
const sections = ["net", "db", "cache", "auth"];
const entries: string[] = [];
for (let i = 0; i < 4000; i++) entries.push(makeEntry(i));

let loaded = 0;
let sum = 0;
let failed = 0;
const failedKeys = new Map<string, number>();
for (let round = 0; round < rounds * 40; round++) {
  for (const section of sections) {
    for (const entry of entries) {
      try {
        sum += loadEntryWithContext(section, entry, defaults);
        loaded++;
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        failed++;
        failedKeys.set(error.key, (failedKeys.get(error.key) ?? 0) + 1);
      }
    }
  }
}
console.log(`loaded ${loaded} failed ${failed} sum ${sum} distinct failing keys ${failedKeys.size}`);
console.log(`net.k0 failures ${failedKeys.get("net.k0") ?? 0}`);
