// A record flows into a string-keyed dictionary type and is written through
// it, so values of that dictionary type, and of the record types that extend
// it, are checked views of their objects. `+=` on a string member of such a
// value appends, as in Node.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Common = Record<string, Json> & { id?: string | null; format?: string; index?: number };
type Summary = Common & { kind: "summary"; summary: string };
type Note = Common & { kind: "note"; text: string; count: number; mark?: string | null };
type Detail = Summary | Note;

const plain = { a: 1 };
const dictionary: Record<string, Json> = plain;
dictionary.b = 2;
console.log(dictionary === plain, plain.a, Object.keys(plain).join(","));

const note = JSON.parse('{"kind":"note","text":"a","count":1}') as unknown as Note;
note.text += "b";
const suffix = ["c", "d"].join("");
note.text += suffix;
note.text += `${note.count}`;
note.text += note.count;
note.count += 2;
const appended = (note.text += "!");
console.log(note.kind, note.text, note.count, appended);

// The same through a union narrowed to one arm, with the shared fields
// filled in by a function that takes the type the arms extend.
function fill(target: Common, source: Detail): void {
  target.id ??= source.id;
  target.format ||= source.format;
  target.index ??= source.index;
}
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
const details = JSON.parse('[{"kind":"note","text":"a","count":0,"extra":1}]') as unknown as Detail[];
append(
  details,
  JSON.parse('{"kind":"note","text":"b","count":0,"id":"x","mark":"s","format":"f"}') as unknown as Detail,
);
append(details, JSON.parse('{"kind":"summary","summary":"s1","index":3}') as unknown as Detail);
append(details, JSON.parse('{"kind":"summary","summary":"s2","id":"y"}') as unknown as Detail);
for (const detail of details) {
  const body = detail.kind === "note" ? `${detail.text}/${detail.mark}` : detail.summary;
  console.log(detail.kind, body, detail.id, detail.format, detail.index);
}
console.log(JSON.stringify(details));
