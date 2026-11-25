export function Panel(props) {
  return "panel " + (props === undefined ? "-" : props.label);
}
