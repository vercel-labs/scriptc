import { publish } from "@scriptc/threads";

// A published array is shared across workers by pointer: the runtime refuses
// one whose out-of-line state (properties, or the prototype it received) is
// mutable, refcounted state of this thread.
function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "published");
  } catch (error) {
    console.log(label, (error as Error).message);
  }
}

const plain: number[] = [1, 2];
attempt("plain", () => {
  publish(plain);
});

const prototyped: number[] = [3, 4];
Object.setPrototypeOf(prototyped, { marker: 1 });
attempt("prototyped", () => {
  publish(prototyped);
});

const nullPrototype: number[] = [5];
Object.setPrototypeOf(nullPrototype, null);
attempt("null-prototype", () => {
  publish(nullPrototype);
});

const plainRecord = { a: 1 };
attempt("record", () => {
  publish(plainRecord);
});

const prototypedRecord = { b: 2 };
Object.setPrototypeOf(prototypedRecord, { marker: 2 });
attempt("record-prototype", () => {
  publish(prototypedRecord);
});

// An instance of a class that extends Array keeps the class's own fields
// after the array header; the shared array would expose state the class
// descriptor owns.
class Numbers extends Array<number> {
  label = "subclass";
}
const subclass = new Numbers();
subclass.push(1);
attempt("subclass", () => {
  publish(subclass);
});
