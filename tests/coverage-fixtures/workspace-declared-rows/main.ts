// A workspace package linked into node_modules declares a row type. The
// program keeps rows in a class field, stores one at an index (so the array
// can hold holes) and searches the field with a callback.
import { Ledger, type Entry, type Sink } from "ledger-kit";

class MemorySink implements Sink {
  public entries: Entry[] = [];
  record(entry: Entry) {
    this.entries.push(entry);
  }
  recordAt(line: number, entry: Entry) {
    this.entries[line] = entry;
  }
}

const run = () => {
  const sink = new MemorySink();
  const ledger = new Ledger({ name: "books", sink });
  const rent = () => {
    const hit = sink.entries.find((e) => e.name === "rent");
    if (!hit) return;
    console.log(hit.name, hit.amount);
  };
  ledger.post("rent", 900);
  sink.recordAt(4, { name: "fuel", amount: 60, tags: {} });
  rent();
};
run();
