// Typed rest signatures still exceed the callable adapter. (A typed preset
// binds to a fixed signature and compiles.)
const preset = ((value: number) => value).bind(null, 1);
const rest = ((...values: number[]) => values.length).bind(null);
export {};
