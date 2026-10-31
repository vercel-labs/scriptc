// Object.entries/values over records whose fields are themselves unions: a
// field value must flow into the result element union, which is WIDER than
// the field whenever the shape has optional keys — `undefined` joins every
// pair's value slot, so even a required `string | number` field re-tags
// into `string | number | undefined`. That is the same runtime re-tag an
// assignment to such a slot performs; the loop body still narrows the
// value with `typeof`/`=== undefined` afterwards.
type ColorValue = string | number;
// A type alias (not an interface) so it satisfies the generic constraint's
// index signature.
type Palette = {
  accent: ColorValue;
  border: ColorValue;
  scrollbarThumb?: ColorValue;
  scrollbarTrack?: ColorValue;
};

// The generic spelling (the theme helper shape): a constrained type
// parameter keeps the optional keys visible to the entries walk.
function describeColors<T extends Record<string, ColorValue>>(colors: T): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(colors)) {
    out.push(`${key}=${typeof value}:${String(value)}`);
  }
  return out;
}

const palette: Palette = { accent: "#00ff00", border: 42, scrollbarThumb: "x" };
for (const line of describeColors(palette)) console.log(line);

// Every optional key present, so no pair takes the undefined branch.
const full: Palette = {
  accent: "#112233",
  border: 0,
  scrollbarThumb: "#445566",
  scrollbarTrack: 7,
};
for (const line of describeColors(full)) console.log(line);

// The concrete (non-generic) spelling narrows each pair's value.
for (const [key, value] of Object.entries(palette)) {
  const shown =
    value === undefined ? `<unset:${key}>` : typeof value === "string" ? value.toUpperCase() : String(value + 1);
  console.log(key, shown);
}

// A THREE-arm present union behind an optional key: the field is neither
// narrowed to one arm nor equal to the result element, so the whole union
// re-tags under the presence guard.
type Setting = string | number | boolean;
interface Settings {
  theme: Setting;
  retries: Setting;
  verbose?: Setting;
}
const settings: Settings = { theme: "dark", retries: 3, verbose: true };
for (const [key, value] of Object.entries(settings)) {
  console.log(key, typeof value, String(value));
}
const sparse: Settings = { theme: "light", retries: 0 };
console.log(Object.entries(sparse).length);
for (const [key, value] of Object.entries(sparse)) console.log(key, String(value));

// The pair value kept as a union local, then narrowed by an explicit test.
const kept: (string | number | boolean | undefined)[] = [];
for (const [, value] of Object.entries(settings)) {
  kept.push(value);
  if (value === undefined) kept.push("<absent>");
  else if (typeof value === "boolean") kept.push(value ? "yes" : "no");
  else kept.push(typeof value);
}
console.log(kept.join("|"));

// Entries consumed by an array method: the same widened pair slot feeds a
// callback.
const described = Object.entries(palette).map(([key, value]) =>
  value === undefined ? `${key}?` : `${key}:${typeof value}`,
);
console.log(described.sort().join(","));
const stringKeys = Object.entries(settings)
  .filter(([, value]) => typeof value === "string")
  .map(([key]) => key);
console.log(stringKeys.join(","));

// Object.values over the same shapes still answers the declared element
// type; narrowing is per element.
const values: string[] = [];
for (const value of Object.values(palette)) {
  values.push(typeof value === "number" ? `#${value}` : value);
}
console.log(values.join(","));
console.log(Object.values(settings).map((v) => typeof v).join(","));
