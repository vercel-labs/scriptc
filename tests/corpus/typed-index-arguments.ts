class Samples {
  values = new Int32Array([11, 22, 33, 44]);
  read(position: number): number { return this.values[position]; }
}
const samples = new Samples();
const positions: number[] = [0, 2, 3];
console.log(samples.read(1), samples.read(positions[0]), samples.read(positions[1]));
let calls = 0;
function position(): number { calls++; return positions[2]; }
console.log(samples.read(position()), calls);
const text = 'abcd';
function letter(position: number): string { return text[position]; }
console.log(letter(1), letter(positions[0]), letter(position()), calls);
function optionalLetter(position: number): string | undefined { return text[position]; }
console.log(optionalLetter(positions[8]), optionalLetter(-1), optionalLetter(0.5));

function first(text: string): string { return text[0]; }
function combine(a: string, b: string): string { return a[0] + b[0]; }
console.log(first('abc'), first(''));
console.log(combine('a', 'b'), combine('', 'b'), combine('', ''));
