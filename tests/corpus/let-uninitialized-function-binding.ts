// A module-scope `let` declared without an initializer is initialized (to
// undefined) where the declaration runs, so a later assignment of a closure
// that calls the binding itself is an ordinary write.
type Step = (n: number) => number;

// A write that runs before the declaration is still in the dead zone.
function early(): void {
  late = () => 1;
}
try {
  early();
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
let late: () => number;
late = () => 2;
early();
console.log(late());

let countdown: Step;
countdown = (n) => (n <= 0 ? 0 : 1 + countdown(n - 1));
console.log(countdown(5));

let log: (s: string) => void;
log = (s) => {
  if (s.length < 3) log(s + "!");
  else console.log(s);
};
log("a");

// Reassignment and assignment from a function body after the declaration.
let pick: (xs: number[]) => number;
function install(largest: boolean): void {
  pick = largest ? (xs) => Math.max(...xs) : (xs) => Math.min(...xs);
}
install(true);
console.log(pick!([3, 9, 4]));
install(false);
console.log(pick!([3, 9, 4]));

// Mutual recursion through two such bindings.
let isEven: (n: number) => boolean;
let isOdd: (n: number) => boolean;
isEven = (n) => (n === 0 ? true : isOdd(n - 1));
isOdd = (n) => (n === 0 ? false : isEven(n - 1));
console.log(isEven(10), isOdd(7), isEven(3));
