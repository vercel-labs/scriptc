// @requires-libnode
// A record the island hands back (`unsafe<T>` declares the caller's own
// type, like typebox's `Type.Unsafe<T>`) crosses out as a deep checked
// copy: the merged type is a required half and an optional half, and the
// native value carries every field the declaration promises.
import { unsafe } from "recordkit";

/** A mapped pair of halves — one record, spelled as an intersection. */
type ColorValues<Value> = { [K in "fg" | "bg"]: Value } & { [K in "accent"]?: Value };

const colors = unsafe<ColorValues<string>>({ fg: "red", bg: "blue" });
console.log(colors.fg, colors.bg, colors.accent === undefined, Object.keys(colors).join(","));

const levels = unsafe<ColorValues<number>>({ fg: 1, bg: 2, accent: 3 });
console.log(levels.fg + levels.bg, levels.accent, Object.keys(levels).join(","));

/** Native code reads the copy's fields by their declared types. */
function describe(values: ColorValues<string>): string {
  return `${values.fg}/${values.bg}/${values.accent ?? "-"}`;
}
console.log(describe(colors), describe({ fg: "green", bg: "black" }));
