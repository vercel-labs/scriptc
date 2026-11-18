// Optional chaining and a possibly-undefined local keep their undefined arm
// as a present undefined element: a missing receiver and a missing member
// both print null from JSON, and a present one keeps its value.
interface Note {
  text?: string;
  id: string;
}

function lookup(empty: boolean): Note | undefined {
  return empty ? undefined : { id: "n" };
}

const found = lookup(false);
const missing = lookup(true);
console.log(JSON.stringify([found?.text, found?.id]));
console.log(JSON.stringify([missing?.text, missing?.id]));
console.log(JSON.stringify([found?.text]));

// A possibly-undefined local and a member of one.
const local: string | undefined = found?.text;
const id: string | undefined = found?.id;
console.log(JSON.stringify([local, id]), local === undefined, id);
console.log(JSON.stringify([missing?.text, local]));

// The receiver expression runs once per element, in source order.
let calls = 0;
function once(empty: boolean): Note | undefined {
  calls++;
  return lookup(empty);
}
const pair = [once(false)?.text, once(true)?.id, once(false)?.id];
console.log(JSON.stringify(pair), calls);

// Optional chaining over a computed member of a possibly-undefined array.
const notes: Note[] | undefined = [{ id: "a" }];
console.log(JSON.stringify([notes?.[0]?.text, notes?.[1]?.text, notes?.[1]?.id]));
function noNotes(): Note[] | undefined {
  return undefined;
}
const absent = noNotes();
console.log(JSON.stringify([absent?.[0]?.text]));
