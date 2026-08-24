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

$ scriptc build fib.ts -o fib && ./fib
832040`;

const COVERAGE_DEMO = `$ scriptc coverage cli.ts

  statements analyzed   4
  compile statically    3  (75%)

  runs with --dynamic   2 sites (embeds a JS engine, ~620KB — static stays the default)
      ×1  importing 'picocolors' requires the embedded dynamic engine — the package's implementation runs there  SC2013`;

const tiers = [
  {
    title: "Compiled statically",
    body: "The default. Ordinary TypeScript — classes, closures, async/await, the stdlib, Node's fs/path/process/http surface — becomes native code with no engine in the binary.",
  },
  {
    title: "Runs dynamically",
    body: "Opt in with --dynamic: an embedded JavaScript engine (~620KB) executes what can't be static — npm dependencies' shipped JS, any-typed code. Every value crossing back into static code is validated at runtime.",
  },
  {
    title: "Rejected at compile time",
    body: "Everything else fails the build with a specific error code, a code frame, and usually a rewrite hint. Nothing is ever silently miscompiled.",
  },
];

const points = [
  {
    title: "No code changes",
    body: "No annotations, no dialect, no special stdlib. The same TypeScript you run on Node, type-checked by the real TypeScript compiler.",
  },
  {
    title: "Small and fast",
    body: "A hello-world binary is ~320KB, starts in about 4ms, and links against nothing but libSystem. Node needs a ~120MB runtime and ~35ms to print the same line.",
  },
  {
    title: "Measured coverage",
    body: "scriptc coverage tells you, statement by statement, what compiles statically, what needs the dynamic engine, and exactly what blocks the rest.",
  },
  {
    title: "Differentially tested",
    body: "Every corpus program runs under Node and as a native binary; stdout, stderr, and exit codes must match byte-for-byte. The whole corpus re-runs under AddressSanitizer.",
  },
];

function TerminalPane({ title, code }: { title: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-gray-alpha-400 bg-background-100 text-left shadow-card">
      <div className="flex items-center gap-1.5 border-b border-gray-alpha-400 bg-background-200 px-4 py-2.5 dark:bg-gray-alpha-100">
        <span className="h-2.5 w-2.5 rounded-full bg-gray-500" />
        <span className="h-2.5 w-2.5 rounded-full bg-gray-500" />
        <span className="h-2.5 w-2.5 rounded-full bg-gray-500" />
        <span className="ml-3 font-mono label-12 text-gray-900">{title}</span>
      </div>
      <div className="[&>div]:my-0! [&>div]:rounded-none! [&>div]:border-none! [&>div]:bg-transparent!">
        <Code lang="console">{code}</Code>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="relative mx-auto max-w-[1200px] px-6 pt-16 text-center sm:pt-24">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-gray-900 sm:text-xs sm:tracking-[0.25em]">
            macOS · Linux · Windows
          </p>
          <h1 className="mx-auto mt-4 max-w-5xl heading-40 text-gray-1000 sm:heading-64 lg:heading-72">
            TypeScript-to-Native <br className="hidden sm:block" />
            Compiler
          </h1>
          <p className="mx-auto mt-4 max-w-2xl copy-16 text-gray-900 sm:copy-18">
            Ordinary TypeScript becomes a small, fast native binary — no Node, no V8, no
            JavaScript engine required.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link
              href="/quickstart"
              className="flex h-10 items-center rounded-md bg-gray-1000 px-5 button-14 text-background-100 transition-opacity hover:opacity-90"
            >
              Get Started
            </Link>
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-10 items-center rounded-md border border-gray-alpha-400 px-5 button-14 text-gray-1000 transition-colors hover:border-gray-alpha-500"
            >
              GitHub
            </a>
          </div>
        </div>
        <div className="relative mx-auto mt-8 max-w-3xl px-6 pb-16 sm:mt-10 sm:pb-24">
          <TerminalPane title="fib.ts — compiled with scriptc" code={HERO_DEMO} />
        </div>
      </section>

      {/* Three tiers */}
      <section className="border-t border-gray-alpha-400">
        <div className="mx-auto max-w-[1200px] px-6 py-16">
          <h2 className="heading-24 text-gray-1000">Three tiers, always explicit</h2>
          <p className="mt-3 max-w-2xl copy-14 text-gray-900">
            Every construct in your program lands in exactly one tier, and the tier is the
            promise.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {tiers.map((tier, i) => (
              <div key={tier.title} className="rounded-lg border border-gray-alpha-400 p-6">
                <div className="label-12 font-medium uppercase tracking-wider text-gray-700">
                  Tier {i + 1}
                </div>
                <h3 className="mt-2 heading-16 text-gray-1000">{tier.title}</h3>
                <p className="mt-2 copy-13 text-gray-900">{tier.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Coverage demo */}
      <section className="border-t border-gray-alpha-400">
        <div className="mx-auto max-w-[1200px] px-6 py-16">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div>
              <h2 className="heading-24 text-gray-1000">Staticness you can see</h2>
              <p className="mt-3 copy-14 text-gray-900">
                Most TypeScript is far more static than the ecosystem assumes. {siteName}{" "}
                decides, construct by construct, what can compile to native code — and tells
                you. A binary never silently grows an engine: the dynamic tier is opt-in, and
                the coverage report names every site that needs it.
              </p>
              <Link
                href="/coverage"
                className="mt-4 inline-block label-14 text-gray-1000 underline underline-offset-4"
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
                <h3 className="heading-16 text-gray-1000">{point.title}</h3>
                <p className="mt-2 copy-13 text-gray-900">{point.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <section className="border-t border-gray-alpha-400">
        <div className="mx-auto max-w-[1200px] px-6 py-16 text-center">
          <h2 className="heading-24 text-gray-1000">Compile your first binary</h2>
          <p className="mx-auto mt-3 max-w-xl copy-14 text-gray-900">
            Clone the repository, build the compiler, and turn a TypeScript file into a native
            executable in a couple of minutes.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link
              href="/quickstart"
              className="flex h-10 items-center rounded-md bg-gray-1000 px-5 button-14 text-background-100 transition-opacity hover:opacity-90"
            >
              Quickstart
            </Link>
            <Link
              href="/introduction"
              className="flex h-10 items-center rounded-md border border-gray-alpha-400 px-5 button-14 text-gray-1000 transition-colors hover:border-gray-alpha-500"
            >
              Introduction
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
