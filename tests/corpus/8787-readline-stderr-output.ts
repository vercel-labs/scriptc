// readline/promises over a writable stream: createInterface with
// process.stderr as its output writes the question prompts to descriptor 2
// (the interface's stream output, not the stdout fast path), and question
// options given as a runtime value read only .signal: a live signal answers,
// an aborted one rejects with the AbortError and its cause, and a truthy
// non-signal rejects with ERR_INVALID_ARG_TYPE. The callback interface
// writes its prompt and echoes lines the same way.
import { createInterface } from "node:readline/promises";
import { createInterface as createCallback } from "node:readline";
import { Readable } from "node:stream";

type QuestionOptions = { signal?: AbortSignal };

async function ask(line: string, query: string, options?: QuestionOptions): Promise<string> {
  const rl = createInterface({ input: new Readable({ read() {} }), output: process.stderr });
  const pending = rl.question(query, options);
  rl.write(line + "\n");
  const answer = await pending;
  rl.close();
  return answer;
}

async function main(): Promise<void> {
  console.log("answer1:", JSON.stringify(await ask("alpha", "q1? ")));
  console.log("answer2:", JSON.stringify(await ask("beta", "q2? ")));

  // options as a variable: one `signal` read, as Node reads it
  const live = new AbortController();
  const opts = { signal: live.signal };
  console.log("answer3:", JSON.stringify(await ask("gamma", "q3? ", opts)));

  const aborted = new AbortController();
  aborted.abort("stop");
  try {
    await ask("delta", "q4? ", { signal: aborted.signal });
  } catch (e) {
    const err = e as { name: string; code?: string; cause?: unknown };
    console.log("rejected:", err.name, err.code, String(err.cause));
  }

  try {
    await ask("epsilon", "q5? ", { signal: 5 } as unknown as QuestionOptions);
  } catch (e) {
    const err = e as { code?: string };
    console.log("invalid:", err.code);
  }

  // the shorthand binding the pi idiom writes
  const signal = new AbortController().signal;
  console.log("answer5:", JSON.stringify(await ask("zeta", "q6? ", { signal })));

  const lines: string[] = [];
  const cb = createCallback({
    input: new Readable({ read() {} }),
    output: process.stderr,
    terminal: false,
  });
  cb.on("line", (line: string) => lines.push(line));
  cb.prompt();
  cb.write("one\n");
  cb.write("two\n");
  await new Promise<void>((resolve) => {
    cb.on("close", () => {
      console.log("lines:", JSON.stringify(lines));
      resolve();
    });
    cb.close();
  });
}

void main();
