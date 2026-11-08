// A JavaScript package that asks its own function about `process.stdout`
// and `process.stderr` while its module loads (the function's JSDoc types
// the parameter `{ isTTY?: boolean | undefined }`), imported by a program
// that passes plain records only: the package's calls pass the streams
// themselves.
import { linkSupport } from "term-links";
import links from "term-links";

console.log(linkSupport({ isTTY: false }), typeof linkSupport({ isTTY: true }));
console.log(links.stdout, links.stderr);
