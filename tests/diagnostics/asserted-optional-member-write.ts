// A WRITE to a member only an asserted intersection declares: Node adds the
// property to the object itself, but the record the binding holds has no
// slot for it. A width copy would take the write and drop it — a silent
// divergence — so the write is refused by name. A write to a member the
// stored layout DECLARES keeps its ordinary lowering
// (tests/corpus/8990-asserted-optional-member-reads.ts), and the READ of
// such a member answers from the record's kept source.
interface Base {
  name: string;
}

const item = JSON.parse('{"name":"n"}') as Base;
const view = item as Base & { icons?: unknown };
view.icons = ["z"];
view.name = "renamed";
console.log(String(view.icons), view.name, JSON.stringify(item));
