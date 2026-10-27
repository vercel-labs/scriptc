// .groups on matchAll rows reached through array callbacks (map, forEach,
// filter, some, find), Array.from's mapping function and parameter
// destructuring, on rows kept by filter, slice and toReversed or picked by
// find and at, with plain, duplicate and nonparticipating named groups.
const text = "a1b2c3";
console.log([...text.matchAll(/(?<k>[a-z])/g)].map((m) => m.groups!.k).join(""));
console.log([...text.matchAll(/(?<k>[a-z])|(?<k>\d)/g)].map((m) => m.groups!.k).join(""));
console.log(Array.from(text.matchAll(/(?<d>\d)/g), (m) => m.groups!.d).join("+"));
const rows = [...text.matchAll(/(?<letter>[a-z])(?<digit>\d)/g)];
rows.forEach((m) => console.log(m.groups!.letter, m.groups!.digit, JSON.stringify(m.groups)));
console.log(rows.filter((m) => m.groups!.digit !== "2").length);
console.log(rows.some((m) => m.groups!.letter === "c"), rows.find((m) => m.groups!.digit === "3") !== undefined);
console.log(rows.map(({ groups }) => groups!.letter + groups!.digit).join(","));
console.log(rows[0]!.groups);
const mixed = [..."2024 and x9".matchAll(/(?<word>[a-z]+)|(?<num>\d+)/g)];
console.log(mixed.filter((m) => m.groups!.num !== undefined).map((m) => m.groups!.num).join(","));
console.log(mixed.slice(1).map((m) => m.groups!.word ?? m.groups!.num).join(" "));
console.log(mixed.find((m) => m.groups!.word === "and")!.groups);
console.log(mixed.at(-1)!.groups!.num, mixed.toReversed().map((m) => m.groups!.word ?? "-").join(""));
