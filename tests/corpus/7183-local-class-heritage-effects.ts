// A class defined inside a function evaluates its `extends` expression
// every time the definition runs, even when the base it names is fixed:
// calls in the heritage run in order, and a heritage call that throws
// stops the definition.
class Base {
  tag(): string {
    return "base";
  }
}
const log: string[] = [];
function select(note: string): typeof Base {
  log.push(`select ${note}`);
  return Base;
}

function define(round: number): string {
  class Local extends select(`declaration ${round}`) {}
  return new Local().tag();
}
for (let round = 0; round < 2; round++) log.push(define(round));

function expressionForm(): string {
  const Made = class extends select("expression") {};
  return new Made().tag();
}
log.push(expressionForm());

function nested(): string {
  class Outer extends select("outer") {}
  class Inner extends Outer {}
  return new Inner().tag();
}
log.push(nested());

function refuse(): typeof Base {
  throw new Error("heritage failed");
}
function failing(): void {
  try {
    class Never extends refuse() {}
    log.push(new Never().tag());
  } catch (error) {
    log.push((error as Error).message);
  }
}
failing();

const arrow = (n: number): string => {
  class InArrow extends select(`arrow ${n}`) {}
  return new InArrow().tag();
};
log.push(arrow(1));

console.log(log.join("\n"));
