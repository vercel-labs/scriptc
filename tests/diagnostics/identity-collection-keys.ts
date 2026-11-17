interface Key { id: number }
interface Wide { id: number; extra: string }
const wide: Wide = { id: 1, extra: "kept" };
const narrow = new Map<Key, number>();
// Copying an existing wider record would lose JavaScript key identity.
narrow.set(wide, 1);
narrow.get(wide);
narrow.has(wide);
narrow.delete(wide);
const seeded = new Map<Key, number>([[wide, 1]]);
console.log(seeded);
const members = new Set<Key>();
members.add(wide);
members.has(wide);
const seededMembers = new Set<Key>([wide]);
console.log(seededMembers);

// Mixed and nullable key unions preserve each arm's value or identity.
const mixed = new Map<Key | string, number>();
const nullable = new Set<Key | undefined>();
console.log(mixed, nullable);

// Casting a checked-dynamic snapshot to a key must not hide the copy.
const unknownKey: unknown = wide;
narrow.get(unknownKey as Key);

// Array key covariance also allocates a new container in the static tier.
const narrowArrays = new Map<Key[], number>();
const wideArray: Wide[] = [wide];
narrowArrays.set(wideArray, 1);

// An explicit record assertion must not hide the same structural copy.
narrow.get(wide as Key);
members.delete((wide as Key)!);
new Set<Key>([wide as Key]);

// A dynamic array or tuple seed is the sequence of keys, not one key: the
// checked array conversion runs and every element keeps its identity.
const unknownKeys: unknown = [{ id: 1 }];
new Set<Key>(unknownKeys as Key[]);
new Set<Key>(unknownKeys as [Key]);
