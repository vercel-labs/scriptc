// A union of records narrowed at the call to one arm, passed to a parameter
// of the type the arms share: the callee's writes reach the element the
// caller holds, as in Node.

type Common = { id?: string | null; format?: string; index?: number };
type Summary = Common & { kind: "summary"; summary: string };
type Sealed = Common & { kind: "sealed"; data: string };
type Note = Common & { kind: "note"; text: string; mark?: string | null };
type Detail = Summary | Sealed | Note;

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

function show(detail: Detail): string {
  const body =
    detail.kind === "note"
      ? `${detail.text}/${detail.mark}`
      : detail.kind === "summary"
        ? detail.summary
        : detail.data;
  return `${detail.kind} ${body} ${detail.id} ${detail.format} ${detail.index}`;
}

const parsed = JSON.parse('[{"kind":"note","text":"a"}]') as unknown as Detail[];
append(
  parsed,
  JSON.parse('{"kind":"note","text":"b","id":"x","mark":"s","format":"f"}') as unknown as Detail,
);
append(parsed, JSON.parse('{"kind":"summary","summary":"s1","index":3}') as unknown as Detail);
append(parsed, JSON.parse('{"kind":"summary","summary":"s2","id":"y"}') as unknown as Detail);
append(parsed, JSON.parse('{"kind":"sealed","data":"d","id":"z"}') as unknown as Detail);
append(parsed, JSON.parse('{"kind":"sealed","data":"e","index":9}') as unknown as Detail);
for (const detail of parsed) console.log(show(detail));
console.log(parsed.map((detail) => JSON.stringify(detail).length).join(" "));

const typed: Detail[] = [{ kind: "summary", summary: "t1" }];
append(typed, { kind: "summary", summary: "t2", id: "i", format: "g", index: 1 });
append(typed, { kind: "note", text: "n1", index: 4 });
append(typed, { kind: "note", text: "n2", id: "j", mark: "m" });
for (const detail of typed) console.log(show(detail));

// Other ways the argument is narrowed to one arm.
function stamp(target: Common, id: string): void {
  target.id ??= id;
}
function viaSwitch(detail: Detail): void {
  switch (detail.kind) {
    case "note":
      stamp(detail, "switch-note");
      break;
    case "summary":
      stamp(detail, "switch-summary");
      break;
    case "sealed":
      stamp(detail, "switch-sealed");
      break;
  }
}
function viaIn(detail: Detail): void {
  if ("text" in detail) stamp(detail, "in-note");
  else if ("data" in detail) stamp(detail, "in-sealed");
  else stamp(detail, "in-summary");
}
const slot: { current: Detail } = { current: { kind: "note", text: "held" } };
if (slot.current.kind === "note") stamp(slot.current, "member");
const viaSwitchValues: Detail[] = [
  { kind: "note", text: "a" },
  { kind: "summary", summary: "b" },
  { kind: "sealed", data: "c" },
];
const viaInValues: Detail[] = [
  { kind: "note", text: "a" },
  { kind: "summary", summary: "b" },
  { kind: "sealed", data: "c", id: "kept" },
];
for (const detail of viaSwitchValues) viaSwitch(detail);
for (const detail of viaInValues) viaIn(detail);
console.log(viaSwitchValues.map((detail) => detail.id).join(","));
console.log(viaInValues.map((detail) => detail.id).join(","), slot.current.id);
