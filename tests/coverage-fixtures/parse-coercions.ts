// parseFloat over a string and Number.parseInt over a string with a radix
// lower statically; other argument types coerce, which only the embedded
// engine runs.
const text: string = process.argv.length > 99 ? "1.5" : "2.25";
const flag: boolean = process.argv.length > 99;
const count: number = process.argv.length;
console.log(parseFloat(text), Number.parseFloat(text), Number.parseInt("ff", 16));
console.log(parseFloat(flag as unknown as string));
console.log(Number.parseInt(count as unknown as string, 10));
