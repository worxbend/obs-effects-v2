import {
  createEffect,
  createMemo,
  createSignal,
  Errored,
  For,
  Loading,
  refresh,
  Show,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  ApiError,
  createPreset,
  deletePreset,
  describeError,
  listPresets,
  updatePreset,
} from "~/api/client";
import { mergeParams, sparseParams } from "~/effects/registry";
import type { EffectDescriptor, Preset, PresetWriteRequest } from "~/types/contract";
import { Banner } from "~/components/Banner";

/** The longest name the backend accepts, checked here so a typo costs no round trip. */
const MAX_PRESET_NAME = 64;

/**
 * The "Presets" card inside the route editor: save the values in the form under a name, and load a
 * saved set back into it.
 *
 * ## A preset belongs to one effect, and the UI makes that structural
 *
 * A preset is a set of parameter values, and parameter values only mean anything next to the
 * effect that declared them — "speed" is a different quantity for the starfield and for the
 * plasma shader, and a key one effect declares may not exist on another at all. The backend
 * refuses a mismatch, but being refused after pressing a button is a poor way to learn a rule.
 *
 * So the rule is enforced by what this component can see. It is handed the *descriptor* of the
 * effect currently chosen in the form — not a list of every preset — and it asks the API only for
 * that effect's presets. There is no control anywhere in it that could name a different effect, so
 * "apply a preset belonging to another effect" is not a thing the operator can express. Picking a
 * different effect in the form above swaps this list for that effect's own.
 *
 * The second filter, the `p.effectId === id` test below, is not redundant with the server's
 * query: it means the guarantee holds even if the filter parameter were ever dropped or misspelt.
 */
export function RoutePresets(props: {
  /** The effect currently chosen in the form, or `undefined` when none is chosen or implemented. */
  descriptor: EffectDescriptor | undefined;
  /** The COMPLETE parameter set currently in the form, defaults already merged in. */
  values: Record<string, unknown>;
  /** Called with a complete parameter set when the operator applies a preset. */
  onApply(next: Record<string, unknown>): void;
}): JSX.Element {
  /**
   * The presets of the currently chosen effect.
   *
   * An **async memo**: `createMemo` whose function returns a promise, which is Solid 2's
   * replacement for `createResource`. Reading `presets()` while the request is in flight suspends
   * and the `<Loading>` below shows its fallback; a failure throws on read and `<Errored>` catches
   * it. With no effect chosen it returns a plain array and no promise at all, so nothing suspends
   * and the card does not flash a loading line.
   */
  const presets = createMemo<Preset[]>(() => {
    const id = props.descriptor?.id;
    if (!id) return [];
    return listPresets(id).then((list) => list.filter((preset) => preset.effectId === id));
  });

  return (
    <div class="card">
      <div class="card-title">
        <h2>Presets</h2>
        <a href="/admin/presets" class="btn btn-sm">
          Manage presets
        </a>
      </div>

      <Show
        when={props.descriptor}
        fallback={
          <p class="faint">
            Choose an effect above first. A preset is a set of values for one particular effect, so
            there is nothing to list until the form knows which effect it is editing.
          </p>
        }
      >
        {(descriptor) => (
          /*
           * These boundaries are deliberately *inside* the card rather than around the page. The
           * route editor has boundaries of its own around the whole form; if this list relied on
           * those, a backend that cannot answer `GET /api/presets` would replace the entire editor
           * with an error message, and an operator who only wanted to change a colour would be
           * unable to. A card that says "presets could not be loaded" while the rest of the form
           * keeps working is the honest failure.
           */
          <Errored
            fallback={(failure) => (
              <Banner
                kind="error"
                message={`Presets could not be loaded: ${describeError(failure())}`}
              />
            )}
          >
            <Loading fallback={<p class="muted">Loading presets…</p>}>
              <PresetPanel
                descriptor={descriptor()}
                presets={presets()}
                values={props.values}
                // Wrapped rather than passed straight through: reading `props.onApply` here and
                // handing the function on would detach it from `props`, which is both a lint
                // error and a habit that breaks the moment a caller passes a real method.
                onApply={(next) => props.onApply(next)}
                onChanged={() => refresh(presets)}
              />
            </Loading>
          </Errored>
        )}
      </Show>
    </div>
  );
}

/**
 * The card's contents once the list has arrived.
 *
 * Splitting this out is what keeps every read of the async memo above in one place: this component
 * receives an ordinary array, so its click handlers can use the list without the possibility of
 * reading a promise that has not settled. An event handler is not inside a `<Loading>` boundary,
 * and a suspending read there would be an error rather than a fallback.
 */
function PresetPanel(props: {
  descriptor: EffectDescriptor;
  presets: Preset[];
  values: Record<string, unknown>;
  onApply(next: Record<string, unknown>): void;
  onChanged(): void;
}): JSX.Element {
  const [draftName, setDraftName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal<string | null>(null);
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);
  /** The preset whose values were last put into the form, purely so the row can say so. */
  const [appliedId, setAppliedId] = createSignal<string | null>(null);

  const trimmedName = createMemo(() => draftName().trim());

  /*
   * Forget the messages when the form switches to a different effect.
   *
   * This component is not rebuilt when that happens — the list it is given is replaced, and it
   * stays mounted — so without this, “Loaded ‘Neon night’ into the form” would sit above a list of
   * a completely different effect's presets, naming one that is no longer in it. A stale
   * confirmation is worse than no confirmation: it describes something that is no longer true.
   *
   * `compute` reads the id and `apply` does the clearing, which is the two-function shape Solid 2
   * uses everywhere in this project: the tracked half decides *when*, the untracked half does the
   * work. It also runs once on mount, where clearing what is already clear costs nothing.
   */
  createEffect(
    () => props.descriptor.id,
    () => {
      setSaved(null);
      setError(null);
      setAppliedId(null);
    },
  );

  /**
   * The existing preset whose name matches what is typed, ignoring case.
   *
   * Names are unique per effect and compared without regard to case, so typing the name of a
   * preset that already exists can only ever mean "replace that one". Detecting it here turns
   * what would be a `409 NAME_CONFLICT` into a button that says "Overwrite" before it is pressed.
   */
  const nameMatch = createMemo(() => {
    const wanted = trimmedName().toLowerCase();
    if (wanted === "") return undefined;
    return props.presets.find((preset) => preset.name.trim().toLowerCase() === wanted);
  });

  const nameIssue = createMemo(() => {
    const name = trimmedName();
    if (name.length > MAX_PRESET_NAME) {
      return `A preset name is at most ${MAX_PRESET_NAME} characters.`;
    }
    return null;
  });

  const canSave = () => trimmedName() !== "" && nameIssue() === null && !busy();

  const save = async () => {
    const name = trimmedName();
    if (name === "" || nameIssue() !== null) return;

    const body: PresetWriteRequest = {
      name,
      effectId: props.descriptor.id,
      // Stored sparse, exactly like a route's parameters: only what differs from the effect's own
      // defaults. A preset that recorded every default would freeze today's defaults into itself,
      // and applying it later would silently undo an improvement made in the effect's code.
      params: sparseParams(props.descriptor, props.values),
    };

    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const match = nameMatch();
      if (match) {
        await updatePreset(match.id, body);
        setSaved(`Preset “${name}” overwritten with the values in this form.`);
      } else {
        await createPreset(body);
        setSaved(`Preset “${name}” saved.`);
      }
      setDraftName("");
      props.onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "NAME_CONFLICT") {
        // Only reachable if somebody created that name in another tab between this list arriving
        // and the button being pressed.
        setError(
          `This effect already has a preset called “${name}”. Refresh the page to overwrite it, or pick another name.`,
        );
      } else {
        setError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (preset: Preset) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await deletePreset(preset.id);
      setConfirmingId(null);
      if (appliedId() === preset.id) setAppliedId(null);
      setSaved(`Preset “${preset.name}” deleted.`);
      props.onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Copies a preset's values into the form.
   *
   * Nothing is saved: this writes into the editor's parameter state and leaves the operator in
   * front of an unsaved form, which is the point. A preset is a starting position, and the
   * adjustment afterwards is the reason to start from one — which is also why the contract has no
   * server-side "apply preset to route" endpoint.
   *
   * `mergeParams` turns the preset's sparse values back into a complete set, so a key the preset
   * does not mention returns to the effect's default rather than keeping whatever the form had.
   * Applying a preset therefore always produces exactly the look that was saved.
   */
  const apply = (preset: Preset) => {
    setError(null);
    setAppliedId(preset.id);
    setSaved(
      `Loaded “${preset.name}” into the form. Nothing is stored until you save the route itself.`,
    );
    props.onApply(mergeParams(props.descriptor, preset.params));
  };

  return (
    <>
      <Banner kind="error" message={error()} />
      <Banner kind="ok" message={saved()} />

      <Show
        when={props.presets.length > 0}
        fallback={
          <p class="faint">
            No presets for {props.descriptor.name} yet. Set the parameters below the way you want
            them, then save them here under a name.
          </p>
        }
      >
        <ul class="preset-list">
          <For each={props.presets}>
            {(preset) => (
              <li class="preset-item">
                <div class="preset-item-text">
                  <span class="preset-item-name">
                    {preset.name}
                    <Show when={appliedId() === preset.id}>
                      <span class="badge badge-on">in the form</span>
                    </Show>
                  </span>
                  <span class="faint">{describeValueCount(preset)}</span>
                </div>

                <Show
                  when={confirmingId() === preset.id}
                  fallback={
                    <div class="cell-actions">
                      <button
                        type="button"
                        class="btn btn-sm"
                        disabled={busy()}
                        onClick={() => apply(preset)}
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm btn-danger"
                        disabled={busy()}
                        onClick={() => {
                          setError(null);
                          setConfirmingId(preset.id);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  }
                >
                  {/* The same in-page confirmation the route list uses. Never `window.confirm`:
                      it blocks the whole browser thread, cannot be styled, and cannot be driven
                      by a test. */}
                  <div class="confirm-row">
                    <span>Delete “{preset.name}”?</span>
                    <button
                      type="button"
                      class="btn btn-sm"
                      disabled={busy()}
                      onClick={() => setConfirmingId(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-danger"
                      disabled={busy()}
                      onClick={() => void remove(preset)}
                    >
                      Yes, delete
                    </button>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <div class="field preset-save">
        <label class="field-label" for="preset-name">
          Save the current parameters as a preset
        </label>
        <div class="preset-save-row">
          <input
            id="preset-name"
            type="text"
            autocomplete="off"
            spellcheck={false}
            placeholder="Neon night"
            maxlength={MAX_PRESET_NAME}
            class={nameIssue() ? "invalid" : undefined}
            value={draftName()}
            onInput={(e) => {
              setDraftName(e.currentTarget.value);
              setError(null);
            }}
            /*
             * This input sits inside the route editor's `<form>`, whose submit handler saves the
             * *route*. Pressing Enter in a text field submits the enclosing form, which would save
             * the route when the operator meant to save a preset — so Enter is intercepted here
             * and does the thing the field is for.
             */
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (canSave()) void save();
            }}
          />
          {/*
            `type="button"` matters for the same reason: inside a form, a button with no type is a
            submit button, and this one must never save the route.
          */}
          <button type="button" class="btn" disabled={!canSave()} onClick={() => void save()}>
            {busy() ? "Saving…" : nameMatch() ? "Overwrite" : "Save preset"}
          </button>
        </div>
        <Show when={nameIssue()}>{(message) => <p class="field-error">{message()}</p>}</Show>
        <p class="field-help">
          <Show
            when={nameMatch()}
            fallback={
              <>
                Presets belong to one effect. This one will be saved for{" "}
                <strong>{props.descriptor.name}</strong> and offered whenever a route uses that
                effect. Only values that differ from the effect's own defaults are stored.
              </>
            }
          >
            {(match) => (
              <>
                <strong>{match().name}</strong> already exists for this effect, so saving replaces
                its values with the ones in this form. Change the name to keep both.
              </>
            )}
          </Show>
        </p>
      </div>
    </>
  );
}

/**
 * "3 values stored", or the honest "every value at the effect's default" for a preset that
 * overrode nothing.
 *
 * Exported because the presets page shows the same line, and one wording is one thing to change.
 */
export function describeValueCount(preset: Preset): string {
  const count = Object.keys(preset.params).length;
  if (count === 0) return "every value at the effect's default";
  return count === 1 ? "1 value stored" : `${count} values stored`;
}
