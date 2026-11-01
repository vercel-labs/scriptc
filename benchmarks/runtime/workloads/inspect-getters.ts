// util.inspect over records that carry accessor properties, with the
// getters option running them: renders of a fixed table of rows whose
// getters answer a number, a string, a small record and a throwing one,
// accumulating the rendered length.
import { inspect } from "node:util";

interface Row {
  get id(): number;
  get label(): string;
  get meta(): { tag: string };
  get bad(): number;
  plain: number;
  note: string;
}

const scale = Number(process.argv[2] ?? "1");
const rows: Row[] = [];
for (let i = 0; i < 64; i++) {
  rows.push({
    get id(): number {
      return i * 3 + 1;
    },
    get label(): string {
      return "row-" + i;
    },
    get meta(): { tag: string } {
      return { tag: "t" + (i % 7) };
    },
    get bad(): number {
      throw { code: i % 5 };
    },
    plain: i,
    note: "n" + (i % 11),
  });
}

let total = 0;
const rounds = Math.floor(400 * scale);
for (let r = 0; r < rounds; r++) {
  for (const row of rows) total += inspect(row, { getters: true }).length;
}
console.log(total);
