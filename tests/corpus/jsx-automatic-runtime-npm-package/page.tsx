import { version } from 'react';

export function page() {
  const el = <div id="a">hi</div>;
  return [el.type, el.props.id, el.props.children, version].join(' ');
}
