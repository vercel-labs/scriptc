// WeakSet members on garbage cycles, with and without their set.
//
// A reading room keeps a WeakSet of the readers inside. Readers come in
// pairs that name each other, so a dropped pair is a cycle only a collector
// pass frees, and that pass must take both members out of every set they are
// in. Some rooms are part of the cycle themselves (a reader names its room,
// the room names a reader through a WeakMap entry's value), some outlive
// their readers by a few hundred rounds, and one room lasts the whole run.
// Every ninth round forces a collector pass while the round's readers and
// rooms are alive, which ages the rooms' collections ahead of their rooms.
class Mote {
  other: Mote | null = null;
}

// Dead two-object cycles: enough of them make the collector run a pass over
// the young objects while the caller's locals are alive.
function churn(n: number): void {
  for (let i = 0; i < n; i++) {
    const a = new Mote();
    const b = new Mote();
    a.other = b;
    b.other = a;
  }
}

class Reader {
  id: number;
  friend: Reader | null = null;
  room: Room | null = null;
  constructor(id: number) {
    this.id = id;
  }
}

class Badge {
  readonly reader: Reader;
  constructor(reader: Reader) {
    this.reader = reader;
  }
}

class Room {
  readonly inside: WeakSet<Reader> = new WeakSet();
  readonly badges: WeakMap<Reader, Badge> = new WeakMap();
  visits: number = 0;
}

const hall = new Room();
const rooms: Array<Room> = [];
let sum = 0;

function enter(room: Room, reader: Reader): void {
  room.inside.add(reader);
  room.visits++;
}

function round(n: number): void {
  const a = new Reader(n);
  const b = new Reader(-n);
  a.friend = b;
  b.friend = a;
  enter(hall, a);
  enter(hall, b);
  // A room on the readers' own cycle: the reader names the room, and the
  // room's badge for that reader names the reader.
  const own = new Room();
  a.room = own;
  enter(own, a);
  enter(own, b);
  own.badges.set(a, new Badge(a));
  own.badges.set(b, new Badge(a));
  // A room that outlives the pair.
  const slot = (n - 1) % 300;
  if (rooms.length <= slot) rooms.push(new Room());
  else if (n % 7 === 0) rooms[slot] = new Room();
  const late = rooms[slot];
  enter(late, a);
  late.badges.set(b, new Badge(b));
  if (n % 9 === 0) churn(200);
  sum += hall.inside.has(a) && own.inside.has(b) && late.inside.has(a) ? 1 : 0;
  sum += late.inside.has(b) ? 100 : 0;
  sum += own.badges.get(b)!.reader.id === n ? 1 : 0;
}

for (let i = 1; i <= 3000; i++) {
  round(i);
}
let visits = 0;
for (const room of rooms) visits += room.visits;
console.log('set member cycle', sum, hall.visits, visits);
