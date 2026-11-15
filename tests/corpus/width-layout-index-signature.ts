// Records with an index signature passed to a parameter of the
// index-signature type they extend: the callee's writes reach the caller's
// record, and its keyed reads and enumerations see the whole object, as in
// Node.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Common = Record<string, Json> & { id?: string | null; format?: string; index?: number };
type Summary = Common & { kind: "summary"; summary: string };
type Sealed = Common & { kind: "sealed"; data: string };
type Note = Common & { kind: "note"; text: string; mark?: string | null };
type Detail = Summary | Sealed | Note;

function fill(target: Common, source: Detail): void {
  target.id ??= source.id;
  target.format ||= source.format;
  target.index ??= source.index;
}

// A union narrowed to one arm at the call.
function append(details: Detail[], detail: Detail): void {
  const last = details[details.length - 1];
  if (detail.kind === "note" && last?.kind === "note") {
    last.text += detail.text;
    last.mark ||= detail.mark;
    fill(last, detail);
    return;
  }
  if (detail.kind === "summary" && last?.kind === "summary") {
    last.summary += detail.summary;
    fill(last, detail);
    return;
  }
  details.push({ ...detail });
}

function show(detail: Detail): string {
  const body =
    detail.kind === "note"
      ? `${detail.text}/${detail.mark}`
      : detail.kind === "summary"
        ? detail.summary
        : detail.data;
  const extra = "extra" in detail ? JSON.stringify(detail.extra) : "-";
  return `${detail.kind} ${body} ${detail.id} ${detail.format} ${detail.index} ${extra}`;
}

const details = JSON.parse('[{"kind":"note","text":"a","extra":1}]') as unknown as Detail[];
append(
  details,
  JSON.parse(
    '{"kind":"note","text":"b","id":"x","mark":"s","format":"f","more":[2]}',
  ) as unknown as Detail,
);
append(details, JSON.parse('{"kind":"summary","summary":"s1","index":3}') as unknown as Detail);
append(details, JSON.parse('{"kind":"summary","summary":"s2","id":"y"}') as unknown as Detail);
for (const detail of details) console.log(show(detail));
console.log(details.map((detail) => JSON.stringify(detail).length).join(" "));

// A single record, not a union.
function fillFrom(target: Common, source: Note): void {
  target.id ??= source.id;
  target.format ||= source.format;
  target.index ??= source.index;
}
const left = JSON.parse('{"kind":"note","text":"a","extra":1}') as unknown as Note;
const right = JSON.parse(
  '{"kind":"note","text":"b","id":"x","format":"f","index":2}',
) as unknown as Note;
fillFrom(left, right);
left.text += right.text;
console.log(left.kind, left.text, left.id, left.format, left.index, left.extra);
console.log(Object.keys(left).sort().join(","));

// Keyed reads, `in`, enumeration and identity inside the callee.
function stamp(target: Common, id: string): string {
  target.id ??= id;
  return Object.keys(target).sort().join(",");
}
function has(target: Common, key: string): boolean {
  target.id = "h";
  return key in target;
}
function size(target: Common): number {
  target.id = null;
  let n = 0;
  for (const key in target) n += key.length;
  return n;
}
function same(a: Common, b: Common): boolean {
  return a === b;
}
const note = JSON.parse('{"kind":"note","text":"t","extra":[1,2]}') as unknown as Note;
console.log(stamp(note, "s"), note.id, note.kind);
console.log(has(note, "text"), has(note, "extra"), has(note, "nope"), note.id);
console.log(size(note), note.id, same(note, note), same(note, left));
