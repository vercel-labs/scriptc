// Objects that refer to each other in a ring and each hold a member of a
// list that was just made. Nothing refers to the ring once its function
// returns, but its objects keep each other alive until the cycle collector
// finds them, which is after the list is gone: the list's members must
// still be there when the ring lets go of them.
class Stop {
  mile: number;
  name: string;
  constructor(mile: number, name: string) {
    this.mile = mile;
    this.name = name;
  }
}
class Leg {
  at: Stop;
  next: Leg | null;
  constructor(at: Stop) {
    this.at = at;
    this.next = null;
  }
}
function stops(n: number): Stop[] {
  const made: Stop[] = [];
  for (let i = 0; i < n; i++) made.push(new Stop(i * 4, "stop" + String(i * 9)));
  return made;
}
function loop(route: Stop[]): Leg {
  const first = new Leg(route[0]!);
  let last = first;
  for (let i = 1; i < route.length; i++) {
    const leg = new Leg(route[i]!);
    last.next = leg;
    last = leg;
  }
  last.next = first;
  return first;
}
function roundTrip(n: number): string {
  const route = stops(n);
  const start = loop(route);
  return start.next!.at.name + String(route.length);
}
function manyTrips(n: number): string {
  let out = "";
  for (let k = 2; k < n; k++) {
    const route = stops(k);
    const start = loop(route);
    out += start.next!.next!.at.name + ";";
  }
  return out;
}
function inPlaceTrip(n: number): string {
  return loop(stops(n)).next!.at.name;
}

console.log("roundTrip " + roundTrip(5));
console.log("manyTrips " + manyTrips(7));
console.log("inPlaceTrip " + inPlaceTrip(4));
// More work after the rings are garbage: the memory of the lists is reused
// before the collector runs.
let reused = 0;
for (let k = 0; k < 50; k++) reused += stops(40).length;
console.log("reused " + String(reused));
