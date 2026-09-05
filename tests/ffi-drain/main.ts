// The embedded shape: the HOST owns the main thread. The program registers
// a retained callback and hands control to a native "run" function that
// does not return until it decides to; every later re-entry into script
// happens through that callback. Nothing here is scriptc-specific — it is
// how a window shell, an audio callback, or any host loop is embedded.
//
// What is asserted is the seam between two re-entries: a continuation
// scheduled during one of them must be able to run before the next one,
// and the ONLY thing that can make that happen is the host's own drain.
declare function nativeHostRegister(handler: (turn: number) => void): void;
declare function nativeHostRun(): number;
declare function nativeHostResolve(resolve: (value: number) => void): void;

const log: string[] = [];
let flag = "not-run";
let awaited = "not-resolved";

// The idiomatic handler an embedder wants to be able to offer its users.
async function slowTurn(): Promise<void> {
  const value = await new Promise<number>((resolve) => {
    // The host stores the resolve and calls it from its own callback —
    // exactly how a shell-owned timer or file read reports completion.
    nativeHostResolve(resolve);
  });
  awaited = `awaited ${value}`;
}

const handler = (turn: number): void => {
  if (turn === 1) {
    Promise.resolve().then(() => {
      flag = "MICROTASK RAN";
    });
    void slowTurn();
  }
  log.push(`turn ${turn}: flag=${flag} ${awaited}`);
};

nativeHostRegister(handler);
const turns = nativeHostRun();
console.log(log.join("\n"));
console.log(`run returned ${turns}`);
console.log(`after run: flag=${flag} ${awaited}`);
