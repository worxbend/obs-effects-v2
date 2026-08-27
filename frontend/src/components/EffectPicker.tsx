import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { EffectDescriptor } from "~/types/contract";
import { EngineBadge } from "~/components/Badges";

export interface EffectPickerProps {
  /** Every effect that can be chosen, already grouped by category. */
  groups: Array<{ category: string; effects: EffectDescriptor[] }>;
  /** Id of the currently chosen effect, or "" when none is chosen yet. */
  selectedId: string;
  onSelect(id: string): void;
}

/**
 * The effect chooser used by the create and edit forms.
 *
 * It is a grid of buttons rather than a `<select>` dropdown because an effect is a visual thing:
 * you want to see its name, its description and which engine it uses (three.js or pixi.js) side
 * by side while deciding, and grouping by category keeps a long inventory navigable.
 */
export function EffectPicker(props: EffectPickerProps): JSX.Element {
  return (
    <Show
      when={props.groups.length > 0}
      fallback={
        <p class="faint">
          This build contains no effects yet. Add one under <code>src/effects/three/</code> or{" "}
          <code>src/effects/pixi/</code> and list it in <code>src/effects/index.ts</code>.
        </p>
      }
    >
      <For each={props.groups}>
        {(group) => (
          <div class="picker-group">
            <h3>{group.category}</h3>
            <div class="picker-grid">
              <For each={group.effects}>
                {(descriptor) => (
                  <button
                    type="button"
                    // Solid 2's `class` prop takes an array of class names, where an object
                    // contributes each key whose value is true. That is both easier to read than
                    // concatenating a string with a conditional " selected" in it, and cheaper:
                    // Solid toggles the single class that changed instead of rewriting the whole
                    // attribute every time the selection moves.
                    class={["picker-option", { selected: descriptor.id === props.selectedId }]}
                    // `aria-pressed` takes the literal strings ARIA defines, not a JavaScript
                    // boolean: "false" and "no attribute at all" mean different things to a
                    // screen reader, so Solid 2's types refuse to guess which one you meant.
                    aria-pressed={descriptor.id === props.selectedId ? "true" : "false"}
                    onClick={() => props.onSelect(descriptor.id)}
                  >
                    <span class="picker-option-name">
                      {descriptor.name}
                      <EngineBadge engine={descriptor.engine} />
                    </span>
                    <span class="picker-option-desc">{descriptor.description}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </Show>
  );
}
