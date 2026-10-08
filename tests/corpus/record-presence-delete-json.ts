// delete makes an optional field absent; a later write (undefined
// included) makes it present again. JSON round trips decide presence
// from the actual keys. (`at` is declared last, so re-adding it keeps
// the same key order as JS insertion order.)
interface Event {
  name: string;
  tags?: string[];
  at?: number;
}

function show(label: string, e: Event): void {
  console.log(label, "at" in e, Object.hasOwn(e, "at"), Object.keys(e).join(","), JSON.stringify(e), e);
}

const e: Event = { name: "launch", tags: ["x"], at: 10 };
show("start", e);
delete e.at;
show("deleted", e);
e.at = undefined;
show("undefined", e);
e.at = 12;
show("set", e);
delete e.tags;
delete e.at;
show("both-deleted", e);
delete e.at;
show("delete-again", e);
e.tags = [];
show("tags", e);

// Presence survives aliases: a delete through one reference is seen by
// the other.
const alias: Event = e;
delete alias.tags;
show("alias", e);

// JSON.parse into a declared shape: missing keys stay missing.
const parsed = JSON.parse('{"name":"stop","tags":["a","b"]}') as Event;
show("parsed", parsed);
const parsedAt = JSON.parse('{"name":"tick","at":3}') as Event;
show("parsed-at", parsedAt);
const parsedList = JSON.parse('[{"name":"a"},{"name":"b","at":1}]') as Event[];
console.log(parsedList.map((item: Event) => Object.keys(item).join(",")).join(" "));

// Stringify drops both absent and undefined-valued fields, so the round
// trip of a present undefined comes back absent, as in JS.
const roundTrip = JSON.parse(JSON.stringify({ name: "r", at: undefined } as Event)) as Event;
show("round-trip", roundTrip);
const kept = JSON.parse(JSON.stringify({ name: "k", tags: [], at: 0 } as Event)) as Event;
show("kept", kept);
