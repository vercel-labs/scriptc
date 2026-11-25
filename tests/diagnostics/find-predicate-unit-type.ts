// A written type predicate of `.find` / `.findLast` that names `null` alone
// (or `null | undefined`) has no element to convert: the search's result
// would be the bare unit. It is refused by name; a predicate that names a
// type with a value (`string | null`) compiles.
const seats: (string | null)[] = ["A1", null, "B2"];
const gap = seats.find((seat): seat is null => seat === null);
const lastGap = seats.findLast((seat): seat is null => seat === null);
const doors: (number | null | undefined)[] = [1, undefined, null];
const shut = doors.find((door): door is null | undefined => door == null);
const taken = seats.find((seat): seat is string | null => seat !== "A1");
console.log(String(gap), String(lastGap), String(shut), String(taken));
