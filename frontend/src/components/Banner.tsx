import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";

/**
 * A one-line coloured message strip.
 *
 * Every page uses this for its errors and confirmations so that a network failure, a validation
 * failure and a successful save all look like they belong to the same application.
 */
export function Banner(props: {
  kind: "error" | "ok" | "info";
  message: string | null | undefined;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <Show when={props.message}>
      {(text) => (
        <Show
          when={props.kind === "error"}
          fallback={
            <output class={`banner banner-${props.kind}`}>
              {text()}
              {props.children}
            </output>
          }
        >
          <div class={`banner banner-${props.kind}`} role="alert">
            {text()}
            {props.children}
          </div>
        </Show>
      )}
    </Show>
  );
}
