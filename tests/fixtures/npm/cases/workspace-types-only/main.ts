// Two WORKSPACE-LINKED members: `wstypes` ships only declarations (its `main`
// and `types` are the same `.d.ts`), and `wsrecords` ships JavaScript whose
// declared API is typed with wstypes' interfaces. The program takes the types
// with `import type` and builds the records itself: nothing of wstypes runs
// or is asked for an implementation, and wsrecords' functions receive the
// program's records.
import type { Entry, Summary } from "wstypes";
import { label, summarize } from "wsrecords";

class Shelf {
  entries: Entry[] = [];
  last: Entry | undefined;
  add(entry: Entry): number {
    this.last = entry;
    return this.entries.push(entry);
  }
}

const shelf = new Shelf();
shelf.add({ id: "e1", title: "first" });
shelf.add({ id: "e2", title: "second", tags: ["a", "b"] });
const summary: Summary = summarize(shelf.entries);
console.log(summary.count, summary.titles);
console.log(label(shelf.entries[0]!), label(shelf.last!));
const parsed = JSON.parse('{"id":"e3","title":"third","tags":["c"]}') as Entry;
console.log(label(parsed), shelf.add(parsed), summarize(shelf.entries).titles);
