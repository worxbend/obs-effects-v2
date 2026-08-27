import { createMemo, createSignal, Errored, For, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  ApiError,
  createPreset,
  deletePreset,
  describeError,
  listPresets,
  updatePreset,
} from "~/api/client";
import { descriptorsByCategory, getEffect, mergeParams, sparseParams } from "~/effects/registry";
import type { EffectDescriptor, Preset, PresetWriteRequest } from "~/types/contract";
import { Banner } from "~/components/Banner";
import { EffectPicker } from "~/components/EffectPicker";
import { EngineBadge } from "~/components/Badges";
import { ParamsForm } from "~/components/ParamsForm";
import { describeValueCount } from "~/components/RoutePresets";

/** The longest name the backend accepts, checked here so a typo costs no round trip. */
const MAX_PRESET_NAME = 64;

/**
 * `/admin/presets` — every saved preset, grouped by the effect it belongs to.
 *
 * A **preset** is a named set of parameter values for one effect: "Neon night" for the plasma
 * shader. It is attached to no route. Applying one is the route editor copying its values into the
 * form, which the operator then adjusts and saves through the ordinary route endpoints — there is
 * deliberately no server-side "apply this preset to that route", because the adjustment afterwards
 * is the reason to start from a preset at all.
 *
 * This page is where presets are created, renamed, re-tuned and deleted. Applying one lives in the
 * route editor, where the route it would apply to is on screen.
 */
export default function PresetsPage(): JSX.Element {
  /**
   * Every preset, unfiltered.
   *
   * An async memo — Solid 2's replacement for `createResource`. Reading it while the request is in
   * flight suspends and the `<Loading>` shows its fallback; a failure throws on read and
   * `<Errored>` catches it.
   */
  const presets = createMemo(() => listPresets());

  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  /** Id of the preset whose editor is open, or "new" while the create form is open. */
  const [editing, setEditing] = createSignal<string | null>(null);
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);
  const [busyId, setBusyId] = createSignal<string | null>(null);

  const afterWrite = (message: string) => {
    setError(null);
    setNotice(message);
    setEditing(null);
    /*
     * `refresh` re-runs an async memo's function — the replacement for the old resource's
     * `refetch()`. It invalidates rather than tears down, so the list stays on screen showing the
     * previous rows while the fresh one is fetched.
     */
    refresh(presets);
  };

  const remove = async (preset: Preset) => {
    setBusyId(preset.id);
    setError(null);
    setNotice(null);
    try {
      await deletePreset(preset.id);
      setConfirmingId(null);
      afterWrite(`Preset “${preset.name}” deleted.`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div class="page-head">
        <div>
          <h1>Presets</h1>
          <p>
            A preset is a named set of parameter values for one effect. Save one from a route
            editor, or create one here, and it is offered on every route that uses that effect.
            Nothing on this page changes a live source: applying a preset happens in the route
            editor and still has to be saved there.
          </p>
        </div>
        <Show when={editing() !== "new"}>
          <button
            type="button"
            class="btn btn-primary"
            onClick={() => {
              setError(null);
              setNotice(null);
              setEditing("new");
            }}
          >
            New preset
          </button>
        </Show>
      </div>

      <Banner kind="error" message={error()} />
      <Banner kind="ok" message={notice()} />

      <Show when={editing() === "new"}>
        <div class="card">
          <div class="card-title">
            <h2>New preset</h2>
          </div>
          <PresetEditor
            onSaved={(message) => afterWrite(message)}
            onCancel={() => setEditing(null)}
          />
        </div>
      </Show>

      {/*
        The boundaries wrap only the part that reads `presets()`, never the heading or the create
        form above it. If they wrapped the whole page, a refresh after a delete would replace the
        entire screen with "Loading presets…" instead of only the list.
      */}
      <Errored fallback={(failure) => <Banner kind="error" message={describeError(failure())} />}>
        <Loading fallback={<p class="muted">Loading presets…</p>}>
          <Show
            when={presets().length > 0}
            fallback={
              <Show when={editing() !== "new"}>
                <div class="empty">
                  <p>No presets yet.</p>
                  <p class="faint">
                    The quickest way to make one is from a route: set the parameters the way you
                    want them and save them under a name in the editor's “Presets” card.
                  </p>
                </div>
              </Show>
            }
          >
            <For each={groupByEffect(presets())}>
              {(group) => (
                <div class="card">
                  <div class="card-title">
                    <h2>
                      <Show when={group.descriptor} fallback={<code>{group.effectId}</code>}>
                        {(descriptor) => (
                          <>
                            {descriptor().name} <EngineBadge engine={descriptor().engine} />
                          </>
                        )}
                      </Show>
                    </h2>
                    <span class="faint mono">{group.effectId}</span>
                  </div>

                  <Show when={!group.descriptor}>
                    <p class="field-help">
                      This build has no implementation for <code>{group.effectId}</code>, so these
                      presets cannot be edited — the backend checks the effect id against the
                      inventory on every write. They are kept rather than deleted, exactly as a
                      route pointing at a missing effect is, so that restoring the effect brings
                      them back.
                    </p>
                  </Show>

                  <ul class="preset-list">
                    <For each={group.presets}>
                      {(preset) => (
                        <li class="preset-item preset-item-block">
                          <Show
                            when={editing() === preset.id}
                            fallback={
                              <div class="preset-item-row">
                                <div class="preset-item-text">
                                  <span class="preset-item-name">{preset.name}</span>
                                  <span class="faint">
                                    {describeValueCount(preset)} · updated{" "}
                                    {formatTime(preset.updatedAt)}
                                  </span>
                                </div>

                                <Show
                                  when={confirmingId() === preset.id}
                                  fallback={
                                    <div class="cell-actions">
                                      <Show when={group.descriptor}>
                                        <button
                                          type="button"
                                          class="btn btn-sm"
                                          onClick={() => {
                                            setError(null);
                                            setNotice(null);
                                            setEditing(preset.id);
                                          }}
                                        >
                                          Edit
                                        </button>
                                      </Show>
                                      <button
                                        type="button"
                                        class="btn btn-sm btn-danger"
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
                                  {/* In-page confirmation, never `window.confirm`: a native
                                      dialog blocks the whole browser thread, cannot be styled and
                                      cannot be driven by a test. */}
                                  <div class="confirm-row">
                                    <span>Delete “{preset.name}” for good?</span>
                                    <button
                                      type="button"
                                      class="btn btn-sm"
                                      disabled={busyId() === preset.id}
                                      onClick={() => setConfirmingId(null)}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      class="btn btn-sm btn-danger"
                                      disabled={busyId() === preset.id}
                                      onClick={() => void remove(preset)}
                                    >
                                      {busyId() === preset.id ? "Deleting…" : "Yes, delete"}
                                    </button>
                                  </div>
                                </Show>
                              </div>
                            }
                          >
                            <PresetEditor
                              preset={preset}
                              onSaved={(message) => afterWrite(message)}
                              onCancel={() => setEditing(null)}
                            />
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              )}
            </For>
          </Show>
        </Loading>
      </Errored>
    </>
  );
}

/**
 * The create and edit form, which are the same form.
 *
 * `PUT /api/presets/{id}` is a full replacement, exactly like a route update, so editing sends the
 * whole preset — name and parameters together — rather than a patch of what changed. That means
 * one component can serve both cases: the only differences are which HTTP call it makes and
 * whether the effect can still be chosen.
 *
 * The effect is fixed once a preset exists. The API would allow changing it, but a preset's values
 * only mean anything next to the effect that declared them: switching effect would either throw
 * every value away or send keys the new effect has never heard of. Making a new preset for the
 * other effect says what is actually meant.
 */
function PresetEditor(props: {
  /** The preset being edited, or `undefined` when this is a new one. */
  preset?: Preset;
  /** Called after a successful write, with a sentence for the page's banner. */
  onSaved(message: string): void;
  onCancel(): void;
}): JSX.Element {
  const groups = descriptorsByCategory();

  /*
   * Each field is a **writable memo**: `createSignal` given a function instead of a value. It
   * starts out derived from the preset being edited, and the setter overrides it as soon as the
   * operator types. Solid 2 forbids writing a signal from inside a tracking scope, so the older
   * "effect that copies the loaded value into four setters" shape is not available — and this one
   * is better anyway, because there is no effect left to re-run and throw away an edit.
   */
  const [effectId, setEffectId] = createSignal<string>(() => props.preset?.effectId ?? "");
  const [name, setName] = createSignal<string>(() => props.preset?.name ?? "");
  const [values, setValues] = createSignal<Record<string, unknown>>(() => {
    const preset = props.preset;
    const module = preset ? getEffect(preset.effectId) : undefined;
    return module ? mergeParams(module.descriptor, preset?.params) : {};
  });

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [fieldIssues, setFieldIssues] = createSignal<Record<string, string>>({});

  const descriptor = createMemo<EffectDescriptor | undefined>(
    () => getEffect(effectId())?.descriptor,
  );
  const trimmedName = createMemo(() => name().trim());

  const nameIssue = createMemo(() => {
    if (trimmedName().length > MAX_PRESET_NAME) {
      return `A preset name is at most ${MAX_PRESET_NAME} characters.`;
    }
    return null;
  });

  const canSave = () =>
    trimmedName() !== "" && nameIssue() === null && descriptor() !== undefined && !busy();

  /*
   * Choosing a different effect resets the parameters to that effect's defaults. Keeping the old
   * values would send keys the new effect does not declare, which the backend rejects with 422 —
   * unknown keys are an error on purpose, because silently dropping them would hide typos.
   */
  const chooseEffect = (id: string) => {
    if (id === effectId()) return;
    setEffectId(id);
    setFieldIssues({});
    const module = getEffect(id);
    setValues(module ? mergeParams(module.descriptor, {}) : {});
  };

  const save = async (event: Event) => {
    event.preventDefault();
    const spec = descriptor();
    if (!spec || trimmedName() === "" || nameIssue() !== null) return;

    const body: PresetWriteRequest = {
      name: trimmedName(),
      effectId: spec.id,
      // Sparse, exactly like a route's parameters: only what differs from the effect's own
      // defaults, so that improving a default in the effect's code still reaches this preset.
      params: sparseParams(spec, values()),
    };

    setBusy(true);
    setError(null);
    setFieldIssues({});
    try {
      const existing = props.preset;
      if (existing) {
        await updatePreset(existing.id, body);
        props.onSaved(`Preset “${body.name}” saved.`);
      } else {
        await createPreset(body);
        props.onSaved(`Preset “${body.name}” created.`);
      }
    } catch (e) {
      applyError(e, body.name);
    } finally {
      setBusy(false);
    }
  };

  /** Turns an API failure into either per-parameter messages or a message above the form. */
  const applyError = (e: unknown, attempted: string) => {
    if (e instanceof ApiError) {
      if (e.code === "NAME_CONFLICT") {
        setError(
          `This effect already has a preset called “${attempted}”. Preset names are unique per effect, ignoring case.`,
        );
        return;
      }
      const perField: Record<string, string> = {};
      for (const issue of e.issues) {
        // The backend reports parameter problems as "params.<key>"; strip the prefix so the
        // message can sit under the input it belongs to.
        if (issue.field.startsWith("params.")) {
          perField[issue.field.slice("params.".length)] = issue.message;
        }
      }
      setFieldIssues(perField);
    }
    setError(describeError(e));
  };

  return (
    <form class="preset-editor" onSubmit={(e) => void save(e)}>
      <Banner kind="error" message={error()} />

      <div class="field">
        <label class="field-label" for="preset-editor-name">
          Name
        </label>
        <input
          id="preset-editor-name"
          type="text"
          autocomplete="off"
          spellcheck={false}
          placeholder="Neon night"
          maxlength={MAX_PRESET_NAME}
          class={nameIssue() ? "invalid" : undefined}
          value={name()}
          onInput={(e) => {
            setName(e.currentTarget.value);
            setError(null);
          }}
        />
        <Show when={nameIssue()}>{(message) => <p class="field-error">{message()}</p>}</Show>
        <p class="field-help">
          Up to {MAX_PRESET_NAME} characters. Two presets of the <em>same effect</em> cannot share a
          name, ignoring case; two different effects may each have a “Neon night”.
        </p>
      </div>

      <div class="field">
        <Show
          when={props.preset}
          fallback={
            <>
              <span class="field-label">Effect</span>
              <EffectPicker groups={groups} selectedId={effectId()} onSelect={chooseEffect} />
            </>
          }
        >
          {(preset) => (
            <>
              <span class="field-label">Effect</span>
              <p class="faint mono">{preset().effectId}</p>
              <p class="field-help">
                The effect of an existing preset cannot be changed here. Its values only mean
                anything next to the effect that declared them, so “the same preset, but for another
                effect” is a new preset rather than an edit of this one.
              </p>
            </>
          )}
        </Show>
      </div>

      <Show
        when={descriptor()}
        fallback={<p class="faint">Choose an effect to see the values this preset will hold.</p>}
      >
        {(spec) => (
          <div class="field">
            <span class="field-label">Parameters</span>
            <ParamsForm
              descriptor={spec()}
              values={values()}
              issues={fieldIssues()}
              onChange={setValues}
            />
          </div>
        )}
      </Show>

      <div class="btn-row">
        <button type="submit" class="btn btn-primary" disabled={!canSave()}>
          {busy() ? "Saving…" : props.preset ? "Save preset" : "Create preset"}
        </button>
        <button type="button" class="btn" disabled={busy()} onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Splits a flat preset list into one group per effect id.
 *
 * The API already sorts by effect id and then by name, so this only has to walk the list once and
 * start a new group whenever the id changes — no sorting, and the order the backend chose is
 * preserved rather than being second-guessed here.
 */
function groupByEffect(
  presets: Preset[],
): Array<{ effectId: string; descriptor: EffectDescriptor | undefined; presets: Preset[] }> {
  const groups = new Map<string, Preset[]>();
  for (const preset of presets) {
    const bucket = groups.get(preset.effectId);
    if (bucket) bucket.push(preset);
    else groups.set(preset.effectId, [preset]);
  }
  return [...groups.entries()].map(([effectId, list]) => ({
    effectId,
    descriptor: getEffect(effectId)?.descriptor,
    presets: list,
  }));
}

/** Shows "2026-08-23 14:07" in the viewer's own time zone instead of a raw ISO string. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
