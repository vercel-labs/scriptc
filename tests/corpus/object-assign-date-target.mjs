// Object.assign onto a Date, from sources held as untyped values: the call
// answers the same Date and the program goes on. Nothing here reads a copied
// member back; what is pinned is that the copy itself does not stop a
// program whose Date keeps working as one.

const extra = { crew: ["ana", "li"] };
const opened = new Date(86400000);
const stamped = Object.assign(opened, extra);
console.log(stamped === opened, typeof stamped, stamped instanceof Date);
console.log(stamped.getTime(), stamped.toISOString(), stamped.getUTCDate());

// A parsed source, a source with an empty list, and an empty one.
const parsed = JSON.parse('{"dock":4,"notes":["cold"]}');
const closed = Object.assign(new Date(0), { marks: [] }, parsed, {});
console.log(closed instanceof Date, closed.valueOf(), closed.getUTCFullYear());

// A getter, a symbol key, an index key, an array and a string as sources.
const tag = Symbol("tag");
const due = Object.assign(
  new Date(1700000000000),
  {
    get live() {
      return 7;
    },
  },
  { [tag]: 1, plain: 2 },
  { 0: "z" },
  ["p", "q"],
  "hi",
);
due.setUTCHours(6);
console.log(due.toISOString(), JSON.stringify({ due }), Array.isArray(due));

// No source at all, and a plain object beside it still takes its members.
const alone = Object.assign(new Date(5));
const beside = Object.assign({}, extra, parsed);
console.log(alone.getTime(), Object.keys(beside).join(","), beside.crew === extra.crew);
