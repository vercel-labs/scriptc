/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// The per-file pragmas select another factory than the tsconfig's.
import * as React from "./factory.js";

export const viaPragma = (
  <div id="p">
    <>{1}</>
    text
  </div>
);
