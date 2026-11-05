// A union value whose promise arm payload widens into a wider promise-armed
// union: `Promise<void> | undefined` into `Promise<unknown> | undefined`,
// and `Promise<Narrow> | undefined` into `Promise<Wide> | undefined`.
// TypeScript accepts these assignments. The promise keeps its identity and
// its settlement turn; only the settled payload converts, and a rejection
// carries its reason unchanged.

interface Slot {
  label: string;
  pending?: Promise<unknown>;
}

interface Note {
  id: number;
}

interface Annotated {
  id: number;
  note?: string;
}

function settle(flag: boolean): Promise<void> | undefined {
  return flag ? Promise.resolve() : undefined;
}

function valueOf(n: number): Promise<number> | undefined {
  return n > 0 ? Promise.resolve(n) : undefined;
}

function reject(flag: boolean): Promise<number> | undefined {
  return flag ? Promise.reject(new Error("boom")) : undefined;
}

function note(flag: boolean): Promise<Note> | undefined {
  return flag ? Promise.resolve({ id: 7 }) : undefined;
}

function widen(value: Promise<void> | undefined): Promise<unknown> | undefined {
  return value;
}

function widenNote(value: Promise<Note> | undefined): Promise<Annotated> | undefined {
  return value;
}

async function main(): Promise<void> {
  // A statement assignment, both arms.
  const present = settle(true);
  const widened: Promise<unknown> | undefined = present;
  console.log("present", widened === present, widened === undefined, await widened);
  const absent = settle(false);
  const empty: Promise<unknown> | undefined = absent;
  console.log("absent", empty === absent, empty === undefined, await empty);

  // A payload that is a value, not void.
  const count = valueOf(2);
  const counted: Promise<unknown> | undefined = count;
  console.log("count", await counted, counted === count);

  // A rejection keeps its reason.
  const failing = reject(true);
  const checked: Promise<unknown> | undefined = failing;
  try {
    await checked;
  } catch (error) {
    console.log("rejected", (error as Error).message);
  }

  // A widened record payload, in a field and through a function result.
  const noteValue = note(true);
  const annotatedSlot: Promise<Annotated> | undefined = noteValue;
  console.log("note", await annotatedSlot, annotatedSlot === noteValue);
  const missingNote: Promise<Annotated> | undefined = note(false);
  console.log("no note", missingNote === undefined, await missingNote);
  const wider = widenNote(note(true));
  console.log("note result", wider === undefined, await wider);

  // A field, an array element, and a returned union.
  const slot: Slot = { label: "a", pending: present };
  console.log("field", slot.pending === present, slot.pending === undefined);
  console.log("field await", await slot.pending);
  const list: (Promise<unknown> | undefined)[] = [present, absent, count];
  console.log("array", list.map((entry) => entry === undefined).join(","));
  console.log("array await", list[1] === undefined, await list[2]);
  console.log("return", widen(present) === present, widen(absent) === undefined);
}

main();
