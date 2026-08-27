import type { JSX } from "@solidjs/web";
import type { EffectEngine } from "~/types/contract";

/**
 * A small coloured pill naming the rendering library an effect is built with.
 *
 * The prop is the exact `EffectEngine` union ("three" or "pixi"), not `EffectEngine | string`.
 * The wider type read as "be tolerant of an unexpected value", but TypeScript collapses a union of
 * string literals with `string` back down to `string`, so it did not describe two known engines at
 * all — it accepted any string at all, and quietly removed the compiler's ability to tell you when
 * a new engine is added and this ternary stops covering every case. All three call sites already
 * pass a `descriptor.engine`, which is `EffectEngine`, so nothing had to change to narrow it.
 */
export function EngineBadge(props: { engine: EffectEngine }): JSX.Element {
  const cls = () => (props.engine === "three" ? "badge badge-three" : "badge badge-pixi");
  return <span class={cls()}>{props.engine}</span>;
}

/** A pill showing whether a route is currently serving its effect to OBS. */
export function EnabledBadge(props: { enabled: boolean }): JSX.Element {
  return (
    <span class={props.enabled ? "badge badge-on" : "badge badge-off"}>
      {props.enabled ? "enabled" : "disabled"}
    </span>
  );
}
