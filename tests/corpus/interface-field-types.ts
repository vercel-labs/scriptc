// An interface property whose implementing classes store different types.
interface Cell { value: number | string; label(): string }
class Num implements Cell { value = 1; label(): string { return "num"; } }
class Str implements Cell { value = "s"; label(): string { return "str"; } }
function show(cell: Cell): string { return `${cell.label()}=${cell.value}:${typeof cell.value}`; }
console.log(show(new Num()), show(new Str()));
