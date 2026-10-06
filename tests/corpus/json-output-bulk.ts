const controls: string[] = [];
for (let i = 0; i < 32; i++) controls.push(String.fromCharCode(i));
const text = controls.join("") + "\"\\雪🙂" + "ordinary text".repeat(100);
const rows = [{ "nul\0key": text, number: 9007199254740991, flag: true }];
console.log(JSON.stringify(rows));
console.log(JSON.stringify(rows, null, 2));
const parsed = JSON.parse(JSON.stringify(rows)) as { "nul\0key": string; number: number; flag: boolean }[];
console.log(parsed[0]!["nul\0key"] === text, parsed[0]!.number, parsed[0]!.flag);
const numbers = [
  -0, 0, 9, 10, 99, 100, 9999, 10000, 99999999, 100000000,
  2147483647, 2147483648, 4294967295, 4294967296,
  9007199254740989, 9007199254740991, 9007199254740992,
  1000000000000000100, 1e21, 1e-7, 1.25, Number.MIN_VALUE,
  Number.MAX_VALUE, NaN, Infinity, -Infinity,
];
for (const number of numbers) {
  console.log(String(number), String(-number));
  console.log(JSON.stringify({ negative: -number, positive: number }));
}
