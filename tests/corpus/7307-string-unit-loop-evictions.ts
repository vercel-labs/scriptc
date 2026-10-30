// A units copy must not run program code that indexes other strings: a
// comparator sort or a copy from an untyped source can evict the scanned
// text's UTF-16 units while the loop reads them.

function bigText(seed: number): string {
  let s = "";
  for (let i = 0; i < 9000; i++) s += String.fromCharCode(0xe9 + ((i * seed) % 7)) + "ab ";
  return s;
}

const others = [bigText(3), bigText(5), bigText(11), bigText(13), bigText(17)];

let touched = 0;
function touchOthers(): void {
  for (let k = 0; k < others.length; k++) {
    const o = others[k];
    for (let j = 0; j < 80; j++) touched += o.charCodeAt((j * 997 + k) % o.length);
  }
}

function spaces(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 32) n++;
  return n;
}

function sortedWhileScanning(
  s: string,
  values: Float64Array,
  compare: (a: number, b: number) => number,
): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    sum += s.charCodeAt(i);
    if (i % 4096 === 100) values.sort(compare);
  }
  return sum;
}

function copiedWhileScanning(s: string, values: Float64Array, source: any): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    sum += s.charCodeAt(i);
    if (i % 4096 === 100) values.set(source);
  }
  return sum;
}

const text = bigText(7);
// Repeated scans make the runtime hold the text's units.
let warm = 0;
for (let r = 0; r < 4; r++) warm += spaces(text);
console.log("warm", warm);

const values = new Float64Array([3, 1, 2]);
const byValue = (a: number, b: number): number => {
  touchOthers();
  return a - b;
};
console.log("sorted", sortedWhileScanning(text, values, byValue), values.join(","));
for (let r = 0; r < 2; r++) warm += spaces(text);

const source: any = {
  length: 3,
  get 0() {
    touchOthers();
    return 9;
  },
  1: 8,
  2: 7,
};
console.log("copied", copiedWhileScanning(text, values, source), values.join(","));
console.log("touched", touched > 0, spaces(text));
