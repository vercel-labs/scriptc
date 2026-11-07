// Case S: a class that matches the interface without declaring it.
interface Named { name(): string; rank: number }
class User implements Named { rank = 1; n: string; constructor(n: string) { this.n = n; } name(): string { return this.n; } }
class Robot { rank = 7; serial = 42; name(): string { return `r${this.serial}`; } }
function show(x: Named): string { return `${x.name()}/${x.rank}`; }
const all: Named[] = [new User("ann"), new Robot()];
console.log(all.map(show).join(" "), all[1] instanceof Robot, all[0] instanceof User);
const r = new Robot();
const viewed: Named = r;
viewed.rank = 8;
console.log(r.rank, viewed === r, show(viewed));
