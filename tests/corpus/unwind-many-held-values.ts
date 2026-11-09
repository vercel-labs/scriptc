// One statement that holds many values when a step throws: typed code.
// Every step of one statement leaves a value alive until the statement ends, and
// any step can throw. A throw site that holds many values releases them through
// blocks it shares with the statement's other throw sites; a site that holds few
// releases them in place. Each run makes the throw come after a different number
// of steps, on both sides of that limit, and the program goes on afterwards: the
// values made before the throw are released once (the sanitized lane checks), and
// the handler, the finally block and the caller see what Node shows.
let budget = -1;
let strung = 0;
function bead(i: number): string {
  if (strung === budget) throw new RangeError("out of thread at bead " + i);
  strung++;
  return "b" + i.toString(36);
}
const STOPS = [-1, 0, 1, 2, 31, 32, 33, 34, 35, 39, 40];
function attempt(name: string, make: () => string | number): void {
  for (const stop of STOPS) {
    budget = stop;
    strung = 0;
    try {
      console.log(name, stop, "made", make(), strung);
    } catch (error) {
      console.log(name, stop, "threw", (error as Error).message, strung);
    }
  }
  budget = -1;
}

function necklace(): string {
  return bead(0) + bead(1) + bead(2) + bead(3) + bead(4) + bead(5) + bead(6) + bead(7) +
    bead(8) + bead(9) + bead(10) + bead(11) + bead(12) + bead(13) + bead(14) + bead(15) +
    bead(16) + bead(17) + bead(18) + bead(19) + bead(20) + bead(21) + bead(22) + bead(23) +
    bead(24) + bead(25) + bead(26) + bead(27) + bead(28) + bead(29) + bead(30) + bead(31) +
    bead(32) + bead(33) + bead(34) + bead(35) + bead(36) + bead(37) + bead(38) + bead(39);
}
function tray(): string[] {
  return [
    bead(0), bead(1), bead(2), bead(3), bead(4), bead(5), bead(6), bead(7),
    bead(8), bead(9), bead(10), bead(11), bead(12), bead(13), bead(14), bead(15),
    bead(16), bead(17), bead(18), bead(19), bead(20), bead(21), bead(22), bead(23),
    bead(24), bead(25), bead(26), bead(27), bead(28), bead(29), bead(30), bead(31),
    bead(32), bead(33), bead(34), bead(35), bead(36), bead(37), bead(38), bead(39),
  ];
}
function guarded(): string {
  let text = "";
  try {
    text = bead(0) + bead(1) + bead(2) + bead(3) + bead(4) + bead(5) + bead(6) + bead(7) +
      bead(8) + bead(9) + bead(10) + bead(11) + bead(12) + bead(13) + bead(14) + bead(15) +
      bead(16) + bead(17) + bead(18) + bead(19) + bead(20) + bead(21) + bead(22) + bead(23) +
      bead(24) + bead(25) + bead(26) + bead(27) + bead(28) + bead(29) + bead(30) + bead(31) +
      bead(32) + bead(33) + bead(34) + bead(35) + bead(36) + bead(37) + bead(38) + bead(39);
  } catch (error) {
    text = "caught " + (error as Error).message;
  } finally {
    text += "!";
  }
  return text;
}
// The values of an outer statement stay alive while an inner one runs.
function nested(pick: boolean): string {
  return (
    bead(0) + bead(1) + bead(2) + bead(3) + bead(4) + bead(5) + bead(6) + bead(7) +
    bead(8) + bead(9) + bead(10) + bead(11) + bead(12) + bead(13) + bead(14) + bead(15) +
    bead(16) + bead(17) + bead(18) + bead(19) +
    (pick ? wrap(bead(20) + bead(21) + bead(22) + bead(23) + bead(24) + bead(25) + bead(26) + bead(27) +
      bead(28) + bead(29) + bead(30) + bead(31) + bead(32) + bead(33) + bead(34) + bead(35) +
      bead(36) + bead(37) + bead(38) + bead(39)) : bead(40))
  );
}
function wrap(text: string): string {
  return "<" + text.length + ">";
}
function repeated(): number {
  let length = 0;
  for (let round = 0; round < 2; round++) {
    length += (
      bead(0) + bead(1) + bead(2) + bead(3) + bead(4) + bead(5) + bead(6) + bead(7) +
      bead(8) + bead(9) + bead(10) + bead(11) + bead(12) + bead(13) + bead(14) + bead(15) +
      bead(16) + bead(17) + bead(18) + bead(19) + bead(20) + bead(21) + bead(22) + bead(23) +
      bead(24) + bead(25) + bead(26) + bead(27) + bead(28) + bead(29) + bead(30) + bead(31) +
      bead(32) + bead(33) + bead(34) + bead(35) + bead(36) + bead(37) + bead(38) + bead(39)
    ).length;
  }
  return length;
}
function* strand(): Generator<string> {
  yield "start";
  yield bead(0) + bead(1) + bead(2) + bead(3) + bead(4) + bead(5) + bead(6) + bead(7) +
    bead(8) + bead(9) + bead(10) + bead(11) + bead(12) + bead(13) + bead(14) + bead(15) +
    bead(16) + bead(17) + bead(18) + bead(19) + bead(20) + bead(21) + bead(22) + bead(23) +
    bead(24) + bead(25) + bead(26) + bead(27) + bead(28) + bead(29) + bead(30) + bead(31) +
    bead(32) + bead(33) + bead(34) + bead(35) + bead(36) + bead(37) + bead(38) + bead(39);
  yield "end";
}
class Loom {
  private readonly prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  weave(): string {
    const thread = (i: number): string => this.prefix + bead(i);
    return [thread(0), thread(1), thread(2), thread(3), thread(4), thread(5), thread(6), thread(7),
      thread(8), thread(9), thread(10), thread(11), thread(12), thread(13), thread(14), thread(15),
      thread(16), thread(17), thread(18), thread(19), thread(20), thread(21), thread(22), thread(23),
      thread(24), thread(25), thread(26), thread(27), thread(28), thread(29), thread(30), thread(31),
      thread(32), thread(33), thread(34), thread(35), thread(36), thread(37), thread(38), thread(39)].join("").slice(0, 12);
  }
}
async function knotted(): Promise<string> {
  const first = bead(0) + bead(1) + bead(2) + bead(3) + bead(4) + bead(5) + bead(6) + bead(7) +
    bead(8) + bead(9) + bead(10) + bead(11) + bead(12) + bead(13) + bead(14) + bead(15) +
    bead(16) + bead(17) + bead(18) + bead(19);
  await null;
  return (
    first.slice(0, 4) +
    (bead(20) + bead(21) + bead(22) + bead(23) + bead(24) + bead(25) + bead(26) + bead(27) +
      bead(28) + bead(29) + bead(30) + bead(31) + bead(32) + bead(33) + bead(34) + bead(35) +
      bead(36) + bead(37) + bead(38) + bead(39)).length
  );
}

attempt("necklace", () => necklace().length);
attempt("tray", () => tray().length);
attempt("guarded", () => guarded().slice(0, 40));
attempt("nested", () => nested(true).length);
attempt("nested-short", () => nested(false).length);
attempt("repeated", repeated);
attempt("strand", () => {
  let length = 0;
  for (const text of strand()) length += text.length;
  return length;
});
attempt("loom", () => new Loom("~").weave());

async function later(): Promise<void> {
  for (const stop of STOPS) {
    budget = stop;
    strung = 0;
    try {
      console.log("knotted", stop, "made", await knotted(), strung);
    } catch (error) {
      console.log("knotted", stop, "threw", (error as Error).message, strung);
    }
  }
}
void later();
