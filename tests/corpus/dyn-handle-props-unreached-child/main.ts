// A TypeScript entry beside a JavaScript module. The census that decides which
// handle-property table to install reads every loaded JavaScript file as text:
// this program's helper mentions child_process and defineProperty in a comment.
// That used to request the child handle wrapper from a program that can never
// hold a child handle, and the wrapper's install trapped at startup.
import { label } from "./helper.js";

const totals: number[] = [label.length, label.length + 1];
console.log(totals.join(","));
