// External callback returns must cover the whole ABI domain. Literal return
// declarations map to the same IR storage types, but cannot promise what an
// arbitrary host implementation returns.
declare function answerBool(): true;
declare function answerNumber(): 0;

export function run(): number {
  return (answerBool() ? 1 : 0) + answerNumber();
}
