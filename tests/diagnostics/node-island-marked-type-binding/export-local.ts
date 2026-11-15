interface Local {
  n: number;
}

export function twice(local: Local): number {
  return local.n * 2;
}

export { twice as double, Local };
