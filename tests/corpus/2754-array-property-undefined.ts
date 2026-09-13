// Noncanonical numeric keys are ordinary properties and can carry present undefined.
const values: number[] = [7];
const missing = values[9];
values[-1] = missing;
values[0.5] = missing;
values[4294967295] = missing;
console.log("properties", values.length, values[-1], values[0.5], values[4294967295]);
