// Spreading a fixed tuple into an array literal copies its positions in
// order into the literal's element type.
const SCRIPT_FILES: [string, string, string, string, string] = ["a.ts", "a.mts", "a.cts", "a.js", "a.mjs"];
const DATA_FILES = ["a.json"];
const files = [...SCRIPT_FILES, ...DATA_FILES];
console.log(files.length, files.join(","));
const PAIR = ["x", "y"] as const;
const more: string[] = [...PAIR, "z", ...SCRIPT_FILES.slice(0, 1)];
console.log(more);
const numbers: [number, number, number] = [1, 2, 3];
const widened: (number | string)[] = [...numbers, "end"];
console.log(widened);
