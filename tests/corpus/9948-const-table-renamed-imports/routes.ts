// The constant tables of a ferry line and the interface they are read
// through.

export interface Route {
  code: string;
  stops: readonly string[];
  fare: number;
}

export const coast = { code: "C1", stops: ["pier", "mole", "light"], fare: 4 } as const;
export const ridge = { code: "R7", stops: ["gate", "pass"], fare: 6 } as const;
export const delta = { code: "D2", stops: ["weir"], fare: 3 } as const;

const listed: Route[] = [];

export function list(route: Route): void {
  listed.push(route);
}

export function position(route: Route): number {
  return listed.indexOf(route);
}

export function total(route: Route): number {
  return route.stops.length + route.fare;
}
