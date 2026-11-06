// `Object.entries`/`values` over a record whose FIELD unions are a proper
// subset of the element union: `{ accent: number | string; scrollbarThumb?:
// number | string }` enumerates as `[string, number | string | undefined][]`,
// and the required fields' own `number | string` boxes re-tag onto it. The
// field's value is the same runtime value under the element union's tag
// numbering, so the walk pushes it through the union retag instead of
// refusing the whole enumeration. The theme resolver's
// `Object.entries(themeJson.colors)` is this shape.
type ColorValue = string | number;

interface ThemeColors {
  accent: ColorValue;
  dim: ColorValue;
  scrollbarThumb?: ColorValue;
  border: ColorValue;
}

const colors: ThemeColors = { accent: "#ffffff", dim: 2, border: "#010203" };
console.log(Object.entries(colors).map(([key, value]) => `${key}=${typeof value}:${value}`).join(","));
console.log(Object.values(colors).map((value) => (value === undefined ? "absent" : typeof value)).join(","));

// A present optional field is enumerated exactly where Node puts it.
const withThumb: ThemeColors = { accent: "#ffffff", dim: 2, scrollbarThumb: 37, border: "#010203" };
console.log(Object.keys(withThumb).join(","));
console.log(Object.values(withThumb).join(","));

// The resolved table keeps the walk's type: every value flows into the
// record's value slot.
function resolve(theme: ThemeColors): Record<string, string | number> {
  const resolved: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(theme)) {
    if (value === undefined) continue;
    resolved[key] = typeof value === "number" ? value * 2 : value.toUpperCase();
  }
  return resolved;
}
console.log(JSON.stringify(resolve(colors)));
console.log(JSON.stringify(resolve(withThumb)));

// A record whose every field carries the SAME union (no optional field, so
// the element union is the field union): the direct push, unchanged.
interface Pair {
  left: ColorValue;
  right: ColorValue;
}
const pair: Pair = { left: "#a", right: 9 };
for (const [key, value] of Object.entries(pair)) console.log(key, typeof value, value);
for (const value of Object.values(pair)) console.log(typeof value, value);
