// An argument drawn from stored union storage can hold arms no BigInt
// conversion covers, even where the checker narrows the value it consumes.
// The refusal names the type the program wrote and the arms that block it.
type Stored = number | (() => void) | undefined;

const holders: Record<string, Stored> = { count: 1, run: () => console.log("run") };

function show(value: Stored): void {
  if (typeof value === "number") console.log("count", BigInt(value));
}

show(holders["count"]);
show(holders["run"]);
