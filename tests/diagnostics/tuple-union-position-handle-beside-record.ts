// A position of a union of tuples that holds a fetch handle in one arm reads as the
// checked-dynamic value where it holds every other arm's element itself (corpus 9568). A record
// would enter the checked-dynamic value as a copy, and a class instance has no place in it, so a
// position that holds a handle beside either has no read.
class Pallet {
  crates = 4;
}

function shipment(day: number): [null, Response] | [null, { crates: number }] {
  if (day === 0) return [null, new Response('manifest', { status: 200 })];
  return [null, { crates: day }];
}

function delivery(day: number): [Error] | [null, Headers] | [null, Pallet] {
  if (day === 0) return [new Error('closed')];
  if (day === 1) return [null, new Headers({ 'x-dock': '2' })];
  return [null, new Pallet()];
}

const [, load] = shipment(1);
console.log(load instanceof Response ? load.status : load.crates);

const [, dock] = delivery(2);
console.log(dock instanceof Pallet ? dock.crates : 'none');
