// A counter every other module draws from: the order in which the modules
// run is the order of the numbers they get.
let next = 0;
const drawn: string[] = [];
export function id(who: string): number {
  drawn.push(who);
  return next++;
}
export function history(): string {
  return drawn.join(",");
}
