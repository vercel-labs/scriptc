// A narrowed copy is still its source object. When the source type has
// `unknown` members, JSON.stringify walks their values at runtime: an
// undefined one is omitted, a function is omitted or written as null in an
// array, and a toJSON method is called.
interface Wide {
  id: number;
  extra: unknown;
  more?: unknown;
}

interface Narrow {
  id: number;
}

function narrow(wide: Wide): Narrow {
  return wide;
}

console.log(JSON.stringify(narrow({ id: 1, extra: undefined })));
console.log(
  JSON.stringify(narrow({ id: 2, extra: [1, undefined, () => 1], more: { kept: 1, dropped: undefined, call: () => 1 } })),
);
console.log(
  JSON.stringify(
    narrow({
      id: 3,
      extra: {
        toJSON(): number {
          return 5;
        },
      },
    }),
  ),
);
console.log(JSON.stringify(narrow({ id: 4, extra: "text", more: undefined }), null, 1));
console.log(JSON.stringify([narrow({ id: 5, extra: null }), narrow({ id: 6, extra: 0, more: [] })]));
console.log(JSON.stringify({ item: narrow({ id: 7, extra: { nested: [true, null] } }) }, null, "\t"));

// The source's own toJSON replaces the whole value.
interface Hooked {
  id: number;
  toJSON: () => string;
}
function plain(hooked: Hooked): Narrow {
  return hooked;
}
console.log(JSON.stringify(plain({ id: 8, toJSON: () => "replaced" })), JSON.stringify([plain({ id: 9, toJSON: () => "again" })]));

// A fresh record of the narrow type is written by its fields.
const fresh: Narrow = { id: 10 };
console.log(JSON.stringify(fresh), JSON.stringify([fresh]));
