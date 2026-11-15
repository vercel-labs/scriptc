// Data types declared in the project's own declaration file (a setting
// type that holds itself, a plain record) are the program's types: values
// of them are built, spread, read back and passed like values of the same
// types written in a `.ts` file.
import type { Group, Profile, Setting } from "./types";

function depth(value: Setting): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depth));
  if (value !== null && typeof value === "object") {
    return 1 + Math.max(0, ...Object.keys(value).map((key) => depth(value[key] ?? null)));
  }
  return 0;
}

// A parameter, a result, a spread source and an annotated variable.
function overlay(base: Group, extra: Group): Group {
  return { ...base, ...extra, merged: true };
}
function names(group: Group): string {
  return Object.keys(group).sort().join(" ");
}

const defaults: Group = { volume: 3, muted: false, eq: [1, 2, [3, null]], out: { left: "a" } };
const mine = overlay(defaults, { volume: 9, theme: "dusk" });
console.log(names(mine), mine.volume, mine.muted, typeof mine.theme);
console.log(depth(defaults.eq ?? null), depth(defaults.out ?? null), depth(mine), depth("x"));

// The plain record beside it.
function promote(profile: Profile, by: number): Profile {
  return { ...profile, rank: profile.rank + by, tags: [...(profile.tags ?? []), "promoted"] };
}
const first: Profile = { label: "ada", rank: 2 };
const second = promote(first, 3);
console.log(first.rank, second.rank, second.tags?.join(","), second.label);

// Lists and maps of the declared types.
const byLabel = new Map<string, Profile>([[first.label, first]]);
byLabel.set("bo", promote({ label: "bo", rank: 0, tags: ["new"] }, 1));
const ranks: Setting[] = [...byLabel.values()].map((profile) => profile.rank);
console.log(byLabel.size, byLabel.get("bo")?.tags?.length, depth(ranks), ranks.length);
