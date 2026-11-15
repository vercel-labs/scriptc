// @requires-libnode
// Logical assignment to a member of a Node island's object follows
// JavaScript's order: the receiver and the key are evaluated once, the member
// is read once, and the right side runs and is written only where the
// operator selects it (the island's proxy records no write otherwise). The
// expression's value is the value the member kept, or the value written.
import { Scoreboard, counters, current, open, snapshot, trace } from "tally-kit";

let ran = "";
function note(text: string): string {
  ran += text;
  return text;
}
let keys = 0;
function nextKey(): string {
  keys++;
  return "k" + keys;
}

const board = open();
board.title ??= "finals";
board.host ??= note("skipped");
board.note ??= "tied";
console.log(trace());
board.round ||= 7;
board.limit ||= Number(note("9"));
board.limit &&= 4;
board.round &&= 1;
board.open ||= true;
console.log(trace());
console.log(snapshot(), JSON.stringify(ran));

// Fresh literals on the right: an object and an array the island keeps.
board.bonus ??= { points: 5 };
board.players ??= ["lin", "mo"];
board.players ??= [note("never")];
console.log(trace());
console.log(snapshot(), JSON.stringify(ran));

// The value of the expression.
const title = (board.title ??= "semis");
const host = (board.host &&= "bea");
const round = (board.round ||= 0) + 1;
console.log(title, host, round, (board.bonus ??= { points: 0 }).points);
(board.players ??= []).push("zed");
console.log(trace());
console.log(snapshot());

// The receiver is evaluated once.
open();
current().title ??= "one";
current().round ||= 2;
console.log(trace());
console.log(snapshot());

// Keys are evaluated once, and a missing key reads undefined.
const tallies = counters();
tallies[nextKey()] ??= 3;
tallies["wins"] ??= 9;
tallies["losses"] ||= 8;
tallies[nextKey()] &&= 6;
console.log(keys, trace());
console.log(snapshot());

// `this` in a class that extends the island's class.
class League extends Scoreboard {
  settle(): string {
    this.title ??= "league";
    this.host ??= "nobody";
    this.round ||= 12;
    this.limit &&= 1;
    this.bonus ??= { points: 2 };
    return `${this.title} ${this.host} ${this.round} ${this.limit} ${this.bonus.points}`;
  }
}
console.log(new League().settle());
