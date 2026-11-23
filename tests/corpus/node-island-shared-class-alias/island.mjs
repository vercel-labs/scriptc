import { Base, Derived, instance, baseInstance } from "./shared.ts";

export function check() {
  return `${instance.x} ${instance.m()} ${instance instanceof Base} ${instance instanceof Derived}`;
}

export function base() {
  return `${baseInstance.x} ${baseInstance.m()} ${baseInstance instanceof Base} ${baseInstance instanceof Derived}`;
}

export function made() {
  const d = new Derived();
  return `${d.x} ${d.m()} ${d instanceof Derived} ${d instanceof Base}`;
}

export function madeBase() {
  const b = new Base();
  return `${b.x} ${b.m()} ${b instanceof Base} ${b instanceof Derived}`;
}
