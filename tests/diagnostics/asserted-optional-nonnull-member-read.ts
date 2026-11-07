// The non-null spelling of the asserted-only member read over a value that
// can be absent: `(value as Wider | undefined)!.member` names a member only
// the asserted type declares, on a value that is still nullable where the
// member is read. The record it holds when present has no slot for the
// member, so the read is refused by name; the optional chain
// (`(value as Wider | undefined)?.member`) reads it.
interface Base {
  name: string;
}
type Wider = Base & { icons?: string };

function icons(item: Base | undefined): string | undefined {
  return (item as Wider | undefined)!.icons;
}
console.log(String(icons({ name: "n" })));
