import Link from "next/link";
import { Code } from "@/components/code";
import { siteName, githubUrl } from "@/lib/site";

const HERO_DEMO = `$ cat fib.ts
function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
console.log(fib(30));

$ scriptc run fib.ts
832040

$ scriptc build fib.ts -o fib >/dev/null
$ ./fib
832040`;

const COVERAGE_DEMO = `$ cat hello.ts
const who: string = process.argv.length > 2 ? process.argv[2] : "world";
console.log(\`hello, \${who}\`);

$ scriptc coverage hello.ts

  statements analyzed   2
  compile statically    2  (100%)

  fully static — all analyzed statements compile to native code.`;

const steps = [
  {
    title: "Type-check",
    body: "The TypeScript compiler checks your program against your tsconfig.json. scriptc uses the checked types to choose a native representation for every value.",
  },
  {
    title: "Compile",
    body: "LLVM generates machine code for your program and the npm packages it imports. Packages that can't compile natively run in Node islands, and anything unsupported in your own code is reported with a code, a location, and a hint.",
  },
  {
    title: "Ship",
    body: "The result is one executable for macOS, Linux, or Windows, or a WebAssembly module. A program compiled entirely to native code runs without Node.js installed.",
  },
];

const points = [
  {
    title: "TypeScript type checking",
    body: "The compiler uses TypeScript's type information and narrowing rules to select native representations and identify unsupported operations.",
  },
  {
    title: "npm packages included",
    body: "Packages your program imports are built into the executable, which doesn't read node_modules at runtime. Packages that can't compile to native code run in Node islands.",
  },
  {
    title: "Cross-compilation",
    body: "Build for Linux, Windows, and WebAssembly from one machine, and build static libraries for iOS and Android apps.",
  },
  {
    title: "Tested against Node.js",
    body: "The test suite runs each test program under Node.js and as a compiled executable and compares their output and exit codes. AddressSanitizer builds check for memory errors.",
  },
];

function TerminalPane({ title, code }: { title: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-gray-alpha-400 bg-background-100 text-left shadow-card">
      <div className="flex items-center gap-1.5 border-b border-gray-alpha-400 bg-background-200 px-4 py-2.5 dark:bg-gray-alpha-100">
        <span className="h-2.5 w-2.5 rounded-full bg-gray-500" />
        <span className="h-2.5 w-2.5 rounded-full bg-gray-500" />
        <span className="h-2.5 w-2.5 rounded-full bg-gray-500" />
        <span className="ml-3 font-mono text-label-12 text-gray-900">{title}</span>
      </div>
      <div className="[&>div]:my-0! [&>div]:rounded-none! [&>div]:border-none! [&>div]:bg-transparent!">
        <Code lang="console">{code}</Code>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <main id="main-content" tabIndex={-1}>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="relative mx-auto max-w-[1200px] px-6 pt-16 text-center sm:pt-24">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-gray-900 sm:text-xs sm:tracking-[0.25em]">
            macOS · Linux · Windows
          </p>
          <h1 className="mx-auto mt-4 max-w-5xl text-heading-40 text-gray-1000 sm:text-heading-64 lg:text-heading-72">
            TypeScript-to-Native <br className="hidden sm:block" />
            Compiler
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-copy-16 text-gray-900 sm:text-copy-18">
            Compile TypeScript and JavaScript to native executables and WebAssembly.
            Check compilation support with coverage reports.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link
              href="/docs/quickstart"
              className="flex h-10 items-center rounded-md bg-gray-1000 px-5 text-label-14 text-background-100 transition-opacity hover:opacity-90"
            >
              Get Started
            </Link>
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-10 items-center rounded-md border border-gray-alpha-400 px-5 text-label-14 text-gray-1000 transition-colors hover:border-gray-alpha-500"
            >
              GitHub
            </a>
          </div>
        </div>
        <div className="relative mx-auto mt-8 max-w-3xl px-6 pb-16 sm:mt-10 sm:pb-24">
          <TerminalPane title="fib.ts — compiled with scriptc" code={HERO_DEMO} />
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-gray-alpha-400">
        <div className="mx-auto max-w-[1200px] px-6 py-16">
          <h2 className="text-heading-24 text-gray-1000">From TypeScript to a native binary</h2>
          <p className="mt-3 max-w-2xl text-copy-14 text-gray-900">
            Write the same TypeScript you run on Node.js. {siteName} turns it into machine code in
            three steps.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {steps.map((step, i) => (
              <div key={step.title} className="rounded-lg border border-gray-alpha-400 p-6">
                <div className="text-label-12 font-medium uppercase tracking-wider text-gray-700">
                  Step {i + 1}
                </div>
                <h3 className="mt-2 text-heading-16 text-gray-1000">{step.title}</h3>
                <p className="mt-2 text-copy-13 text-gray-900">{step.body}</p>
              </div>
            ))}
          </div>
          <Link
            href="/docs/how-it-works"
            className="mt-6 inline-block text-label-14 text-gray-1000 underline underline-offset-4"
          >
            How it works →
          </Link>
        </div>
      </section>

      {/* Coverage demo */}
      <section className="border-t border-gray-alpha-400">
        <div className="mx-auto max-w-[1200px] px-6 py-16">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div>
              <h2 className="text-heading-24 text-gray-1000">Check compilation support</h2>
              <p className="mt-3 text-copy-14 text-gray-900">
                Run {siteName} coverage on an existing program to see how much of it compiles
                before you build. The report explains anything unsupported and suggests a fix.
              </p>
              <Link
                href="/docs/coverage"
                className="mt-4 inline-block text-label-14 text-gray-1000 underline underline-offset-4"
              >
                Reading coverage reports →
              </Link>
            </div>
            <Code lang="console">{COVERAGE_DEMO}</Code>
          </div>
        </div>
      </section>

      {/* Points */}
      <section className="border-t border-gray-alpha-400">
        <div className="mx-auto max-w-[1200px] px-6 py-16">
          <div className="grid gap-6 sm:grid-cols-2">
            {points.map((point) => (
              <div key={point.title} className="rounded-lg border border-gray-alpha-400 p-6">
                <h3 className="text-heading-16 text-gray-1000">{point.title}</h3>
                <p className="mt-2 text-copy-13 text-gray-900">{point.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <section className="border-t border-gray-alpha-400">
        <div className="mx-auto max-w-[1200px] px-6 py-16 text-center">
          <h2 className="text-heading-24 text-gray-1000">Compile your first binary</h2>
          <p className="mx-auto mt-3 max-w-xl text-copy-14 text-gray-900">
            Install the CLI, create a TypeScript file, and build an executable. The
            quickstart covers platform requirements and npm dependencies.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link
              href="/docs/quickstart"
              className="flex h-10 items-center rounded-md bg-gray-1000 px-5 text-label-14 text-background-100 transition-opacity hover:opacity-90"
            >
              Quickstart
            </Link>
            <Link
              href="/docs"
              className="flex h-10 items-center rounded-md border border-gray-alpha-400 px-5 text-label-14 text-gray-1000 transition-colors hover:border-gray-alpha-500"
            >
              Introduction
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
