// comptime records: nested structures with interface targets, baked as
// record literals against the interned shapes.
interface Palette {
  name: string;
  rgb: number[];
}
interface Theme {
  fg: Palette;
  bg: Palette;
  contrast: number;
}

const theme: Theme = comptime(() => {
  // Outer INTERFACES may be referenced in type positions (annotations are
  // erased before evaluation); outer VALUES may not.
  const mk = (name: string, r: number, g: number, b: number): Palette => ({
    name,
    rgb: [r, g, b],
  });
  const fg = mk("ink", 20, 24, 28);
  const bg = mk("paper", 250, 249, 245);
  let contrast = 0;
  for (const c of fg.rgb) {
    contrast += c;
  }
  return { fg, bg, contrast: (bg.rgb[0] - fg.rgb[0]) / 10 + contrast };
});
console.log(theme.fg.name, theme.bg.name, theme.contrast);
console.log(theme.fg.rgb[0], theme.bg.rgb[2], theme.fg.rgb.length);

// Baked records are ordinary runtime records: reference semantics, writes.
theme.contrast = theme.contrast + 1;
const alias = theme.fg;
alias.name = "midnight";
console.log(theme.fg.name, theme.contrast, alias === theme.fg);

// A record nesting an array of strings, typed by the callback alone.
const meta = comptime(() => {
  const tags: string[] = [];
  for (let i = 0; i < 3; i++) {
    tags.push("t" + i);
  }
  return { kind: "meta", tags, count: tags.length };
});
console.log(meta.kind, meta.tags.join("|"), meta.count);

// A discriminated union whose arms both fit a "labeled" value without a
// label: the discriminant picks the arm.
type Item = { kind: "plain"; v: number } | { kind: "labeled"; v: number; label?: string };
const items: Item[] = comptime(
  () =>
    [
      { kind: "plain", v: 1 },
      { kind: "labeled", v: 2 },
      { kind: "labeled", v: 3, label: "x" },
    ] as Item[],
);
for (const item of items) {
  if (item.kind === "labeled") console.log("labeled", item.v, item.label);
  else console.log("plain", item.v);
}
console.log(JSON.stringify(items));
