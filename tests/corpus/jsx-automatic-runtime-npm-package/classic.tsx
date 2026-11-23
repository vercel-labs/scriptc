/** @jsxRuntime classic */
/** @jsx createElement */
import { createElement } from 'react';

export function classic() {
  const el = <span>ok</span>;
  return [el.type, el.props.children].join(' ');
}
