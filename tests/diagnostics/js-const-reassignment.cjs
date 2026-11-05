// Assigning to a `const` binding. Node throws a TypeError at run time, so the
// construct has no Node-exact native lowering; the triage table
// (frontend/tsc-codes.ts, TS2588) refuses it by name instead of passing the
// checker's text through.
const answer = 42;
answer = 43;
console.log(answer);
