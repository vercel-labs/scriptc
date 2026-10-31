// Dispatch tables of functions: a `Record<string, fn>` of opcode handlers
// called as `ops[name]!(…)`, `ops[name]?.(…)` and through a checked local,
// a `Map<string, fn>` of the same handlers, an array of handlers indexed by
// opcode number, and an object literal of methods. Some handlers declare
// fewer parameters than the table's function type.
type Op = (acc: number, arg: number) => number;

const ops: Record<string, Op> = {
  add: (acc, arg) => acc + arg,
  sub: (acc, arg) => acc - arg,
  mul: (acc, arg) => (acc * arg) % 1000003,
  neg: (acc) => -acc,
  half: (acc) => Math.floor(acc / 2),
  mix: (acc, arg) => (acc ^ arg) & 0xffff,
};

const byName = new Map<string, Op>(Object.entries(ops));
const byCode: Op[] = Object.values(ops);
const names = Object.keys(ops);

const methods = {
  add(acc: number, arg: number): number {
    return acc + arg;
  },
  sub(acc: number, arg: number): number {
    return acc - arg;
  },
  mul(acc: number, arg: number): number {
    return (acc * arg) % 1000003;
  },
};

interface Insn {
  name: string;
  code: number;
  arg: number;
}

function program(length: number): Insn[] {
  const out: Insn[] = [];
  let seed = 12345;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const code = seed % (names.length + 1);
    // One in seven instructions names an opcode no table holds.
    out.push({ name: code < names.length ? names[code]! : "nop", code, arg: (seed >> 8) % 97 });
  }
  return out;
}

function runAsserted(insns: Insn[]): number {
  let acc = 1;
  for (const insn of insns) if (insn.name !== "nop") acc = ops[insn.name]!(acc, insn.arg);
  return acc;
}

function runOptional(insns: Insn[]): number {
  let acc = 1;
  for (const insn of insns) acc = ops[insn.name]?.(acc, insn.arg) ?? acc + 1;
  return acc;
}

function runChecked(insns: Insn[]): number {
  let acc = 1;
  for (const insn of insns) {
    const handler = ops[insn.name];
    if (handler) acc = handler(acc, insn.arg);
  }
  return acc;
}

function runMap(insns: Insn[]): number {
  let acc = 1;
  for (const insn of insns) {
    const handler = byName.get(insn.name);
    if (handler !== undefined) acc = handler(acc, insn.arg);
  }
  return acc;
}

function runArray(insns: Insn[]): number {
  let acc = 1;
  for (const insn of insns) if (insn.code < byCode.length) acc = byCode[insn.code]!(acc, insn.arg);
  return acc;
}

function runMethods(insns: Insn[]): number {
  let acc = 1;
  for (const insn of insns) {
    if (insn.code === 0) acc = methods.add(acc, insn.arg);
    else if (insn.code === 1) acc = methods.sub(acc, insn.arg);
    else if (insn.code === 2) acc = methods["mul"](acc, insn.arg);
  }
  return acc;
}

const rounds = Number(process.argv[2] ?? "4");
const insns = program(200_000);
const totals = [0, 0, 0, 0, 0, 0];
for (let round = 0; round < rounds * 10; round++) {
  totals[0] = (totals[0]! + runAsserted(insns)) % 1e9;
  totals[1] = (totals[1]! + runOptional(insns)) % 1e9;
  totals[2] = (totals[2]! + runChecked(insns)) % 1e9;
  totals[3] = (totals[3]! + runMap(insns)) % 1e9;
  totals[4] = (totals[4]! + runArray(insns)) % 1e9;
  totals[5] = (totals[5]! + runMethods(insns)) % 1e9;
}
console.log(totals.join(" "));
