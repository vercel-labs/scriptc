// `+` over a string read from an array element: the element keeps its
// undefined arm, so the operator decides at run time between joining and
// adding. Both operands are still evaluated left to right, as Node does:
// a left operand that reads a variable sees its value from before the
// right operand runs, even when the right operand writes that variable.
const words: string[] = ["first", "left", "other"];

function assignedOnTheRight(): string {
  let local = words[0];
  const joined = local + (local = "second");
  return joined + ":" + local;
}

// The same read, through a generic function that hands back an element of
// a fresh array.
function throughArray<T>(value: T): T {
  const items: T[] = [value];
  return items[0] as T;
}
function genericElement(): string {
  let local = throughArray("first");
  const joined = throughArray(local + (local = "second"));
  return joined + ":" + local;
}

function writtenByANumberCall(): string {
  let text = words[1];
  const bump = (): number => {
    text = "changed";
    return 1;
  };
  const joined = text + bump();
  return joined + ":" + text;
}

function numberWrittenByTheIndex(): string {
  let count = 1;
  const advance = (): number => {
    count = 5;
    return 2;
  };
  const joined = count + words[advance()];
  return joined + ":" + String(count);
}

function missingThenPresent(): string {
  let gone = words[7];
  const joined = gone + (gone = words[0]);
  return joined + ":" + gone;
}

function bothMissing(): string {
  let gone = words[7];
  const sum = gone + (gone = words[8]);
  return String(sum) + ":" + String(gone);
}

function elementsInOrder(): string {
  let index = -1;
  const next = (): number => {
    index++;
    return index;
  };
  return words[next()] + words[next()] + ":" + String(index);
}

console.log(assignedOnTheRight());
console.log(genericElement());
console.log(writtenByANumberCall());
console.log(numberWrittenByTheIndex());
console.log(missingThenPresent());
console.log(bothMissing());
console.log(elementsInOrder());
