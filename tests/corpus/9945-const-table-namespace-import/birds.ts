// The tables of a module, and the collection that tells them apart.

export interface Bird {
  readonly name: string;
  readonly wingspan?: number;
  readonly mate?: Bird;
}

export const wren = { name: "wren" } as const;
export const heron = { name: "heron", wingspan: 180, mate: wren } as const;
export const swift = { name: "swift", wingspan: 42 } as const;

const aviary = new Set<Bird>();

export function admit(bird: Bird): void {
  aviary.add(bird);
}

export function housed(bird: Bird): boolean {
  return aviary.has(bird);
}

export function census(): number {
  return aviary.size;
}
