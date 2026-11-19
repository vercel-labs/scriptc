// @tsc-jsx
// Callbacks written inline in JSX attributes keep the types the element's
// attribute type gives their parameters, for intrinsic elements and
// components.
import { drive } from "./page.js";

console.log(drive().join("\n"));
