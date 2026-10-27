// Named groups on matchAll rows (array-method callbacks over spread rows,
// duplicate names), through optional chains on exec and match results
// (including null matches), and the groups object's null prototype through
// inspection, declared types and unions. Node.js prints the same.
const text = "a1 b22 c333";
const re = /(?<word>[a-z])(?<num>\d+)/g;
const rows = [...text.matchAll(re)];
console.log(rows.map((m) => `${m.groups!.word}=${m.groups!.num}`).join(" "));
rows.forEach((m) => console.log("each", m.groups?.word, m[0]));
console.log(rows.filter((m) => m.groups!.num.length > 1).length, rows.find((m) => m.groups!.word === "c")?.[0]);
console.log([..."x9y8".matchAll(/(?<l>[a-z])|(?<d>\d)/g)].map((m) => `${m.groups!.l ?? "-"}${m.groups!.d ?? "-"}`).join(","));
console.log(rows.some((m) => m.groups!.word === "b"), rows.every(function (m) { return m.groups!.num !== ""; }));
for (const s of ["2024-05", "nope", "07/1999"]) {
  const m = /(?<year>\d{4})-(?<month>\d{2})|(?<month>\d{2})\/(?<year>\d{4})/.exec(s);
  console.log(s, m?.groups?.year, m?.groups?.month ?? "none", m?.groups);
}
const mm = "id=42".match(/id=(?<id>\d+)/);
console.log(mm?.groups?.id, "nothing".match(/(?<z>z)/)?.groups?.z);
const none = /(?<q>q)/.exec("abc");
console.log(none?.groups, none?.groups?.q === undefined);
const parts = /(?<y>\d)-(?<z>\w)/.exec("1-a")!;
const g = parts.groups!;
console.log(parts.groups, JSON.stringify(g), Object.keys(g), Object.getPrototypeOf(g) === null);
try { console.log(String(g)); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const { y, z } = parts.groups!;
console.log(y, z);
const one = /(?<y>\d)/.exec("1");
console.log(one?.groups);
const maybeGroups = one?.groups;
console.log(maybeGroups);
console.log(one!.groups);
const declared: { [k: string]: string } | undefined = one!.groups;
console.log(declared);
