import { createMemo, For, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { listEffects } from "~/api/client";
import { listDescriptors, listDuplicateIds } from "~/effects/registry";
import { Banner } from "~/components/Banner";
import { EngineBadge } from "~/components/Badges";
import type { EffectDescriptor, ParamSpec } from "~/types/contract";

/**
 * `/admin/effects` — a read-only browser of every effect this build implements.
 *
 * There are two lists in play and it is worth being precise about which is shown:
 *
 *  - the **local registry** — the effects compiled into the JavaScript you are running, which is
 *    the authority on what can actually be drawn. That is what the cards below show.
 *  - the **backend inventory** — what the server has stored, pushed there by this frontend at
 *    startup. If the two disagree, the sync at boot failed and the banner says so.
 */
export default function InventoryPage(): JSX.Element {
  const local = listDescriptors();

  /*
   * An async memo (Solid 2's replacement for `createResource`). The `.catch(() => null)` turns a
   * failed request into the value `null`, because "the backend did not answer" is information this
   * page displays rather than an error that should blank it out.
   */
  const remote = createMemo(() => listEffects().catch(() => null));

  /** Ids the backend stores but this build cannot render — usually a stale inventory. */
  const staleOnServer = () => {
    const stored = remote();
    if (!stored) return [];
    const localIds = new Set(local.map((d) => d.id));
    return stored.filter((d) => !localIds.has(d.id)).map((d) => d.id);
  };

  return (
    <>
      <div class="page-head">
        <div>
          <h1>Effect inventory</h1>
          <p>
            Every effect compiled into this build, with the parameters it accepts. This list is
            pushed to the backend automatically when the app starts, which is how the route editor
            knows what to offer.
          </p>
        </div>
      </div>

      <Show when={listDuplicateIds().length > 0}>
        <Banner
          kind="error"
          message={`Two or more effects declare the same id (${listDuplicateIds().join(", ")}). Only the first of each is reachable — fix the ids in src/effects/index.ts.`}
        />
      </Show>

      {/*
        Only these two banners depend on the backend, so only they sit inside the loading boundary.
        It has no `fallback`, which means it draws nothing at all while the request is in flight —
        the right choice here, because a spinner above a list that is already complete and correct
        would suggest the page is unfinished when it is not.
      */}
      <Loading>
        <Show when={remote() === null}>
          <Banner
            kind="info"
            message="The backend inventory could not be read, so this page shows only what is compiled into the frontend."
          />
        </Show>

        <Show when={staleOnServer().length > 0}>
          <Banner
            kind="info"
            message={`The backend still stores effects this build does not implement: ${staleOnServer().join(", ")}. They disappear the next time the manifest is published successfully.`}
          />
        </Show>
      </Loading>

      <Show
        when={local.length > 0}
        fallback={
          <div class="empty">
            <p>This build contains no effects.</p>
            <p class="faint">
              Add a module under <code>src/effects/three/</code> or <code>src/effects/pixi/</code>{" "}
              and list it in <code>src/effects/index.ts</code>.
            </p>
          </div>
        }
      >
        <div class="inventory-list">
          <For each={local}>{(descriptor) => <EffectWidget descriptor={descriptor} />}</For>
        </div>
      </Show>
    </>
  );
}

/**
 * One effect as a single full-width widget in the list.
 *
 * ## Why a list rather than a grid of cards
 *
 * This page used to lay the effects out as a masonry grid, which was fine when there were six of
 * them. There are now thirty, each with a dozen or more parameters, and a grid of thirty tall cards
 * is a wall: nothing lines up, the eye has no column to run down, and the page is several screens
 * long before you have found anything.
 *
 * A list fixes both halves of that. Every widget starts at the same left edge, so the names form a
 * single column you can scan; and the parameter table — the part that makes a card tall — is folded
 * away behind a `<details>` so the closed state is three lines regardless of how configurable the
 * effect is.
 *
 * ## Why `<details>` rather than a signal and a click handler
 *
 * The browser already implements this. Using the element means the disclosure works before any
 * JavaScript has run, it is keyboard-operable and announced correctly to a screen reader with no
 * ARIA attributes of our own, and the open/closed state costs no reactive state to manage. Writing
 * it by hand would be more code that does the same thing slightly worse.
 */
function EffectWidget(props: { descriptor: EffectDescriptor }): JSX.Element {
  const paramCount = (): number => props.descriptor.params.length;

  return (
    <article class="inventory-widget">
      <header class="inventory-widget-head">
        <div class="inventory-widget-title">
          <h2>{props.descriptor.name}</h2>
          <EngineBadge engine={props.descriptor.engine} />
          <span class="tag">{props.descriptor.category}</span>
        </div>
        <code class="faint mono">{props.descriptor.id}</code>
      </header>

      <p class="muted">{props.descriptor.description}</p>

      <Show when={props.descriptor.previewNotes}>
        {(notes) => <p class="field-help">{notes()}</p>}
      </Show>

      <Show when={props.descriptor.tags.length > 0}>
        <div class="tag-row">
          <For each={props.descriptor.tags}>{(tag) => <span class="tag">#{tag}</span>}</For>
        </div>
      </Show>

      <Show
        when={paramCount() > 0}
        fallback={<p class="field-help">No parameters — this effect has nothing to configure.</p>}
      >
        <details class="inventory-params">
          <summary>
            {paramCount()} parameter{paramCount() === 1 ? "" : "s"}
          </summary>
          <table class="param-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Kind</th>
                <th>Default</th>
                <th>Range</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.descriptor.params}>
                {(spec) => (
                  <tr>
                    <td class="mono">{spec.key}</td>
                    <td class="muted">{spec.kind}</td>
                    <td class="mono">{JSON.stringify(spec.default)}</td>
                    <td class="faint">{describeRange(spec)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </details>
      </Show>
    </article>
  );
}

/** A short human summary of a parameter's allowed values, or an em dash when it is unconstrained. */
function describeRange(spec: ParamSpec): string {
  if (spec.kind === "select") return (spec.options ?? []).join(" | ");
  if (spec.kind === "number") {
    const parts: string[] = [];
    if (spec.min !== undefined || spec.max !== undefined) {
      parts.push(`${spec.min ?? "−∞"} … ${spec.max ?? "∞"}`);
    }
    if (spec.step !== undefined) parts.push(`step ${spec.step}`);
    return parts.join(", ") || "—";
  }
  if (spec.kind === "color") return "#rrggbb";
  if (spec.kind === "text") return "up to 1024 characters";
  return "—";
}
