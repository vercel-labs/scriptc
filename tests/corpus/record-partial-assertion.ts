// A partial `as` assertion keeps the literal's own layout and answers the
// asserted type through a record view: fields the literal never wrote are
// absent, and reflection sees exactly what Node sees.
interface TruncationResult { content: string; truncated: boolean; truncatedBy: "lines" | "bytes" | null; totalLines: number; firstLineExceedsLimit: boolean }
class Panel {
  private truncation?: TruncationResult;
  setComplete(truncation?: TruncationResult): void { this.truncation = truncation; }
  summary(): string { return `${this.truncation?.truncated ?? false}`; }
  dump(): string { return JSON.stringify(this.truncation ?? null); }
  keys(): string { return this.truncation ? Object.keys(this.truncation).join(",") : "-"; }
  hasContent(): boolean { return this.truncation !== undefined && "content" in this.truncation; }
}
function render(truncated: boolean, output: string): string {
  const a = new Panel();
  a.setComplete(truncated ? ({ truncated: true } as TruncationResult) : undefined);
  const b = new Panel();
  b.setComplete(truncated ? ({ truncated: true, content: output } as TruncationResult) : undefined);
  return [a.summary(), a.dump(), a.keys(), a.hasContent(), b.summary(), b.dump(), b.keys(), b.hasContent()].join(" ");
}
console.log(render(true, "out"));
console.log(render(false, "out"));
const full: TruncationResult = { content: "c", truncated: false, truncatedBy: null, totalLines: 3, firstLineExceedsLimit: false };
const p = new Panel(); p.setComplete(full);
console.log(p.summary(), p.dump(), p.keys(), p.hasContent(), full.totalLines + 1);

// An optional field the literal omits reads as undefined, and `in` answers
// false for it.
interface Note { content: string; truncated: boolean; note?: string; count?: number }
function note(flag: boolean): Note {
  return flag ? ({ truncated: true } as Note) : { content: "c", truncated: false, note: "n" };
}
const omitted = note(true);
console.log(omitted.note, omitted.note ?? "none", omitted.count === undefined, typeof omitted.note);
console.log("note" in omitted, "truncated" in omitted, "content" in omitted);
const written = note(false);
console.log(written.note, "note" in written, "count" in written);

// A write of a field the literal omits evaluates its right side first.
const order: string[] = [];
function rhs(): string {
  order.push("rhs");
  return "v";
}
const target = note(true);
try {
  target.content = rhs();
} catch {
  order.push("caught");
}
console.log(order[0]);

// An ordinary record of the asserted type keeps a slot for its absent
// optional field, so a write adds the property.
const plainNote: Note = { content: "c", truncated: false };
plainNote.note = "added";
console.log(plainNote.note, "note" in plainNote, JSON.stringify(plainNote));

// A right side that reassigns the receiver's variable: the original
// receiver takes the write.
let reassigned: Note = { content: "first", truncated: false, note: "n" };
const firstNote = reassigned;
const otherNote: Note = { content: "other", truncated: true, note: "o" };
reassigned.content = ((reassigned = otherNote), "changed");
console.log(firstNote.content, otherNote.content, reassigned === otherNote);
export {};
