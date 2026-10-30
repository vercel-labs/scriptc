// A literal that starts by spreading a value of its own type copies that
// value's keys in their order, then overwrites some of them. It must not
// stop the type from taking the order its other literals write: the
// records below enumerate as created (title before id), not in the
// interface's declared order.
interface Book {
  id: string;
  title: string;
  tags: string[];
  updatedAt: string;
  version: number;
}

type Draft = { title: string; tags: string[] };

function create(draft: Draft, id: string): Book {
  return { ...draft, id, updatedAt: "t1", version: 1 };
}

function update(current: Book, patch: Partial<Draft>): Book {
  return { ...current, ...patch, updatedAt: "t2", version: current.version + 1 };
}

function touch(current: Book): Book {
  return { ...current, version: current.version + 1 };
}

const book = create({ title: "Dune", tags: ["sf"] }, "b1");
console.log(JSON.stringify(book));
const updated = update(book, { title: "Dune Messiah" });
console.log(JSON.stringify(updated));
console.log(Object.keys(touch(updated)).join(","));
console.log(Object.keys(update(updated, { tags: [] })).join(" "));
for (const key in touch(book)) console.log(key);
