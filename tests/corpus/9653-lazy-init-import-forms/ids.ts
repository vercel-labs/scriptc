// A counter the other modules draw from while they load: the numbers they
// get are the order they ran in.
let next = 0;
const drawn: string[] = [];
export function id(who: string): number {
  drawn.push(who);
  return next++;
}
export function history(): string {
  return drawn.join(",");
}
