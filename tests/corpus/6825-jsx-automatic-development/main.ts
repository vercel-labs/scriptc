// @tsc-jsx
// JSX with react-jsxdev: jsxDEV gets the key, static children, the source position and `this`.
import { views } from "./view.js";

for (const view of views()) console.log(view);
