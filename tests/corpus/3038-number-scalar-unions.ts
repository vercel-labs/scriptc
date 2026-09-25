let calls = 0;

function candidate(index: number): number | string | boolean | null | undefined {
  calls++;
  if (index === 0) return -0;
  if (index === 1) return 3.5;
  if (index === 2) return "0x10";
  if (index === 3) return true;
  if (index === 4) return false;
  if (index === 5) return null;
  if (index === 6) return undefined;
  return "invalid";
}

for (let index = 0; index < 8; index++) {
  const value = Number(candidate(index));
  console.log(index, String(value), String(1 / value), calls);
}

function stringOrBoolean(flag: boolean): string | boolean {
  return flag ? " 7 " : false;
}

console.log(Number(stringOrBoolean(true)), Number(stringOrBoolean(false)));
