import { createMemo, createSignal, Errored, For, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import {
  ApiError,
  createRoute,
  describeError,
  getRoute,
  listRoutes,
  updateRoute,
} from "~/api/client";
import { descriptorsByCategory, getEffect, mergeParams, sparseParams } from "~/effects/registry";
import {
  CANVAS_LIMITS,
  normaliseCanvas,
  SLUG_PATTERN,
  type CanvasSettings,
  type RouteConfig,
  type RouteWriteRequest,
} from "~/types/contract";
import { Banner } from "~/components/Banner";
import { EffectPicker } from "~/components/EffectPicker";
import { EffectStage } from "~/components/EffectStage";
import { ParamsForm } from "~/components/ParamsForm";
import { RoutePresets } from "~/components/RoutePresets";

/** Render resolutions offered as one-click buttons, because these are the ones people mean. */
const RESOLUTION_PRESETS: ReadonlyArray<{ label: string; width: number; height: number }> = [
  { label: "1920 × 1080", width: 1920, height: 1080 },
  { label: "1280 × 720", width: 1280, height: 720 },
  { label: "854 × 480", width: 854, height: 480 },
];

/** The cap filled in the first time somebody ticks "limit the frame rate". */
const DEFAULT_FPS_CAP = 30;

/**
 * `/admin/routes/new` and `/admin/routes/:id` — one form used for both creating and editing.
 *
 * The two cases differ in exactly three places (what is loaded at the start, which HTTP call the
 * save button makes, and the heading), so keeping them in one component avoids duplicating the
 * parameter form, the validation and the preview pane.
 *
 * There is a third entry point that reuses all of it: `/admin/routes/new?from=<id>` is
 * **"duplicate this route"** — the create form, pre-filled from an existing route, with a free
 * slug already suggested. See `duplicateSlug` at the bottom of this file for why duplication is
 * done here rather than by an endpoint.
 */
export default function RouteEditorPage(props: { mode: "create" | "edit" }): JSX.Element {
  const params = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams<{ from?: string }>();
  const navigate = useNavigate();

  /* ---------------- loading an existing route ---------------- */

  /** The id of the route this form was pre-filled from, or `undefined` for a blank create. */
  const duplicatedFrom = createMemo(() => {
    if (props.mode !== "create") return undefined;
    const from = searchParams.from;
    return typeof from === "string" && from !== "" ? from : undefined;
  });

  /**
   * The route the form starts from, or `null` when it starts blank.
   *
   * This is an **async memo**, Solid 2's replacement for `createResource`. Note what it returns:
   * a *promise* when there is something to load (which the memo unwraps for you, so `existing()`
   * is a `RouteConfig`, not a `Promise`), and a plain `null` with no promise at all otherwise.
   * That distinction matters — returning a resolved promise would still suspend for one tick, and
   * a blank create form would flash "Loading route…" before appearing.
   *
   * While the promise is in flight, reading `existing()` suspends and the `<Loading>` boundary
   * below shows its fallback. If the request fails, reading throws and `<Errored>` catches it.
   */
  const existing = createMemo<RouteConfig | null>(() => {
    if (props.mode === "edit") {
      const id = params.id;
      return id ? getRoute(id) : null;
    }
    const from = duplicatedFrom();
    return from ? loadDuplicateSource(from) : null;
  });

  /* ---------------- form state ---------------- */

  /*
   * Each field below is a **writable memo**: `createSignal` given a function instead of a value.
   * It starts out derived from the loaded route, and the setter overrides it locally as soon as
   * the operator types something.
   *
   * The Solid 1 version of this file used a `createEffect` that read the loaded route and then
   * called four setters. Solid 2 forbids writing a signal from inside a tracking scope, and more
   * to the point that shape had a real flaw: it silently re-ran and threw away the operator's
   * edits if the source ever changed. Deriving the initial value states the intent directly, and
   * there is no effect left to get the ownership rules wrong in.
   */
  const [slug, setSlug] = createSignal<string>(() => existing()?.slug ?? "");
  const [effectId, setEffectId] = createSignal<string>(() => existing()?.effectId ?? "");
  const [enabled, setEnabled] = createSignal<boolean>(() => existing()?.enabled ?? true);

  /*
   * The canvas fields are held as **text**, not numbers, and that is deliberate.
   *
   * A number input bound to a number signal cannot represent "the operator has selected the
   * contents and is about to type": clearing the box would push `NaN`, or 0, into the model and
   * the form would fight back. Keeping the raw text and parsing it on the way out means the field
   * shows exactly what was typed, and an unparseable value produces a message instead of a
   * silently corrected number.
   */
  const [widthText, setWidthText] = createSignal<string>(() =>
    String(normaliseCanvas(existing()?.canvas).width),
  );
  const [heightText, setHeightText] = createSignal<string>(() =>
    String(normaliseCanvas(existing()?.canvas).height),
  );
  const [fpsCapOn, setFpsCapOn] = createSignal<boolean>(
    () => normaliseCanvas(existing()?.canvas).fpsCap !== null,
  );
  const [fpsCapText, setFpsCapText] = createSignal<string>(() => {
    const cap = normaliseCanvas(existing()?.canvas).fpsCap;
    return cap === null ? String(DEFAULT_FPS_CAP) : String(cap);
  });

  /** The COMPLETE parameter set shown in the form; trimmed to the sparse form only on save. */
  const [values, setValues] = createSignal<Record<string, unknown>>(() => {
    const route = existing();
    if (!route) return {};
    const module = getEffect(route.effectId);
    // A route may point at an effect this build no longer contains. Keep its stored values rather
    // than discarding them, so opening the page does not quietly erase somebody's configuration.
    return module ? mergeParams(module.descriptor, route.params) : { ...route.params };
  });

  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal<string | null>(null);
  /** Per-parameter messages from a 422 response, keyed by parameter name. */
  const [fieldIssues, setFieldIssues] = createSignal<Record<string, string>>({});
  const [slugIssue, setSlugIssue] = createSignal<string | null>(null);
  /** Messages the server sent about `canvas.*`, keyed by the part after the dot. */
  const [canvasIssues, setCanvasIssues] = createSignal<Record<string, string>>({});

  /* ---------------- derived values ---------------- */

  const groups = descriptorsByCategory();
  const selectedModule = createMemo(() => getEffect(effectId()));
  const descriptor = createMemo(() => selectedModule()?.descriptor);

  /** Live slug validation, matching the exact regular expression the backend enforces. */
  const slugValid = createMemo(() => SLUG_PATTERN.test(slug()));

  /*
   * The same range checks the backend applies, run as the operator types.
   *
   * This is not a substitute for the server's validation — the server is still the authority, and
   * a 422 is still handled below. It exists so that a typo is pointed at immediately, next to the
   * input, instead of after a round trip that also loses the "Saved" state of the page.
   */
  const widthIssue = createMemo(() =>
    describeRange(widthText(), CANVAS_LIMITS.minWidth, CANVAS_LIMITS.maxWidth, "Width"),
  );
  const heightIssue = createMemo(() =>
    describeRange(heightText(), CANVAS_LIMITS.minHeight, CANVAS_LIMITS.maxHeight, "Height"),
  );
  const fpsCapIssue = createMemo(() =>
    fpsCapOn()
      ? describeRange(
          fpsCapText(),
          CANVAS_LIMITS.minFpsCap,
          CANVAS_LIMITS.maxFpsCap,
          "The frame cap",
        )
      : null,
  );

  /**
   * The canvas settings as they will be sent, or `null` while any of the three is unusable.
   *
   * `fpsCap: null` is written out rather than omitted. It is the single place in this contract
   * where an explicit `null` is meaningful, because "no cap" has to be distinguishable from "no
   * opinion" on the wire — see `CanvasSettings` in `types/contract.ts`.
   */
  const canvasValue = createMemo<CanvasSettings | null>(() => {
    const width = parseWholeNumber(widthText());
    const height = parseWholeNumber(heightText());
    if (width === null || height === null) return null;
    if (widthIssue() || heightIssue() || fpsCapIssue()) return null;
    const fpsCap = fpsCapOn() ? parseWholeNumber(fpsCapText()) : null;
    return { width, height, fpsCap };
  });

  /** "1280 × 720 — 44% of the pixels of 1920 × 1080", or `null` while the numbers are unusable. */
  const canvasSummary = createMemo(() => {
    const canvas = canvasValue();
    if (!canvas) return null;
    const share = Math.round(((canvas.width * canvas.height) / (1920 * 1080)) * 100);
    return `${canvas.width} × ${canvas.height} is ${share}% of the pixels of a 1920 × 1080 source.`;
  });

  /*
   * Picking a different effect resets the parameters to that effect's defaults. Keeping the old
   * values would send keys the new effect does not declare, which the backend rejects with 422
   * (unknown keys are an error on purpose — silently dropping them would hide typos).
   */
  const chooseEffect = (id: string) => {
    if (id === effectId()) return;
    setEffectId(id);
    setFieldIssues({});
    const module = getEffect(id);
    setValues(module ? mergeParams(module.descriptor, {}) : {});
  };

  /* ---------------- saving ---------------- */

  const canSave = () => slugValid() && effectId() !== "" && canvasValue() !== null && !saving();

  const save = async (event: Event) => {
    event.preventDefault();
    setError(null);
    setSaved(null);
    setFieldIssues({});
    setSlugIssue(null);
    setCanvasIssues({});

    const spec = descriptor();
    if (!spec) {
      setError("Choose an effect before saving.");
      return;
    }
    if (!slugValid()) {
      setSlugIssue("The slug must be 1–64 characters of lowercase letters, digits and hyphens.");
      return;
    }
    const canvas = canvasValue();
    if (!canvas) {
      setError("Fix the canvas settings before saving.");
      return;
    }

    const body: RouteWriteRequest = {
      slug: slug(),
      effectId: effectId(),
      enabled: enabled(),
      // Only values that differ from the effect's declared defaults are stored, so that changing
      // a default in the effect's code still reaches routes that never overrode it.
      params: sparseParams(spec, values()),
      canvas,
    };

    setSaving(true);
    try {
      if (props.mode === "create") {
        const created = await createRoute(body);
        navigate(`/admin/routes/${created.id}`, { replace: true });
        setSaved(`Route “${created.slug}” created.`);
      } else {
        const id = params.id;
        if (!id) throw new Error("This page has no route id in its URL.");
        const updated = await updateRoute(id, body);
        setSaved(`Saved at ${new Date(updated.updatedAt).toLocaleTimeString()}.`);
      }
    } catch (e) {
      applyError(e);
    } finally {
      setSaving(false);
    }
  };

  /** Turns an API failure into either field-level messages or a page-level banner. */
  const applyError = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === "SLUG_CONFLICT") {
        setSlugIssue("Another route already uses this slug. Pick a different one.");
        setError(e.message);
        return;
      }
      const perField: Record<string, string> = {};
      const perCanvasField: Record<string, string> = {};
      for (const issue of e.issues) {
        // The backend reports parameter problems as "params.<key>" and canvas problems as
        // "canvas.<key>"; strip the prefix so the message can sit under the input it belongs to.
        if (issue.field.startsWith("params.")) {
          perField[issue.field.slice("params.".length)] = issue.message;
        } else if (issue.field.startsWith("canvas.")) {
          perCanvasField[issue.field.slice("canvas.".length)] = issue.message;
        } else if (issue.field === "slug") {
          setSlugIssue(issue.message);
        }
      }
      setFieldIssues(perField);
      setCanvasIssues(perCanvasField);
    }
    setError(describeError(e));
  };

  /* ---------------- render ---------------- */

  return (
    <>
      <div class="page-head">
        <div>
          <h1>
            {props.mode === "edit"
              ? "Edit route"
              : duplicatedFrom()
                ? "Duplicate route"
                : "New route"}
          </h1>
          <p>
            Everything on this page is live: the preview on the right runs the real effect with the
            values you are typing, and saving pushes them to any OBS source already showing this
            slug.
          </p>
        </div>
      </div>

      <Banner kind="error" message={error()} />
      <Banner kind="ok" message={saved()} />
      <Show when={duplicatedFrom()}>
        <Banner
          kind="info"
          message="Copied from an existing route. Nothing is saved until you press “Create route”, and the original is left untouched."
        />
      </Show>

      {/*
        The boundaries wrap the form, because everything in it is derived from the loaded route.
        A load that fails replaces the form with the message and a way out: an editor prefilled
        from a route that was never read is worse than no editor, because saving it would overwrite
        the real values with blanks.
      */}
      <Errored
        fallback={(failure) => (
          <>
            <Banner kind="error" message={describeError(failure())} />
            <div class="empty">
              <p class="muted">This route could not be loaded, so it cannot be edited safely.</p>
              <a href="/admin" class="btn">
                Back to routes
              </a>
            </div>
          </>
        )}
      >
        <Loading fallback={<p class="muted">Loading route…</p>}>
          <form class="edit-layout" onSubmit={(e) => void save(e)}>
            {/* -------- left column: the form -------- */}
            <div>
              <div class="card">
                <div class="card-title">
                  <h2>Basics</h2>
                </div>

                <div class="field">
                  <label class="field-label" for="slug">
                    Slug
                  </label>
                  <input
                    id="slug"
                    type="text"
                    class={slug() === "" || slugValid() ? undefined : "invalid"}
                    spellcheck={false}
                    autocomplete="off"
                    placeholder="main-camera"
                    value={slug()}
                    onInput={(e) => {
                      setSlug(e.currentTarget.value);
                      setSlugIssue(null);
                    }}
                  />
                  <p class="field-help">
                    The address OBS will use: <code>/e/{slug() || "your-slug"}</code>. Lowercase
                    letters, digits and hyphens only, 1–64 characters.
                  </p>
                  <Show when={slugIssue()}>{(m) => <p class="field-error">{m()}</p>}</Show>
                </div>

                <div class="field">
                  <label class="checkbox-row">
                    <input
                      type="checkbox"
                      checked={enabled()}
                      onChange={(e) => setEnabled(e.currentTarget.checked)}
                    />
                    <span>Enabled</span>
                  </label>
                  <p class="field-help">
                    Switching this off makes <code>/e/{slug() || "your-slug"}</code> draw nothing at
                    all — a fully transparent page, with no error box, and the running effect is
                    disposed rather than hidden so the graphics card gets its memory back. The
                    configuration is kept, and the preview on the right keeps drawing, so you can
                    still work on a route that is switched off.
                  </p>
                </div>
              </div>

              <div class="card">
                <div class="card-title">
                  <h2>Canvas</h2>
                  <Show when={canvasValue()}>
                    {(canvas) => (
                      <span class="faint mono">
                        {canvas().width}×{canvas().height}
                        {canvas().fpsCap === null ? "" : ` @${canvas().fpsCap}`}
                      </span>
                    )}
                  </Show>
                </div>

                <div class="field">
                  <div class="canvas-size-row">
                    <div>
                      <label class="field-label" for="canvas-width">
                        Width
                      </label>
                      <input
                        id="canvas-width"
                        type="number"
                        inputmode="numeric"
                        min={CANVAS_LIMITS.minWidth}
                        max={CANVAS_LIMITS.maxWidth}
                        step={1}
                        class={widthIssue() || canvasIssues()["width"] ? "invalid" : undefined}
                        value={widthText()}
                        onInput={(e) => {
                          setWidthText(e.currentTarget.value);
                          setCanvasIssues({});
                        }}
                      />
                      <Show when={widthIssue() ?? canvasIssues()["width"]}>
                        {(m) => <p class="field-error">{m()}</p>}
                      </Show>
                    </div>

                    <div>
                      <label class="field-label" for="canvas-height">
                        Height
                      </label>
                      <input
                        id="canvas-height"
                        type="number"
                        inputmode="numeric"
                        min={CANVAS_LIMITS.minHeight}
                        max={CANVAS_LIMITS.maxHeight}
                        step={1}
                        class={heightIssue() || canvasIssues()["height"] ? "invalid" : undefined}
                        value={heightText()}
                        onInput={(e) => {
                          setHeightText(e.currentTarget.value);
                          setCanvasIssues({});
                        }}
                      />
                      <Show when={heightIssue() ?? canvasIssues()["height"]}>
                        {(m) => <p class="field-error">{m()}</p>}
                      </Show>
                    </div>
                  </div>

                  <div class="resolution-row">
                    <For each={RESOLUTION_PRESETS}>
                      {(preset) => (
                        <button
                          type="button"
                          class="btn btn-sm"
                          onClick={() => {
                            setWidthText(String(preset.width));
                            setHeightText(String(preset.height));
                            setCanvasIssues({});
                          }}
                        >
                          {preset.label}
                        </button>
                      )}
                    </For>
                  </div>

                  <p class="field-help">
                    This is the <strong>render resolution</strong>, not the size of the OBS browser
                    source. The effect is drawn at exactly these pixels and then scaled to fit
                    whatever size the source is, keeping its shape and staying transparent around
                    the edges. Drawing an ambient background at 1280 × 720 instead of 1920 × 1080
                    asks the graphics card for well under half the pixels — and the work it does not
                    do on your overlay is work it can spend on the game you are streaming. Width{" "}
                    {CANVAS_LIMITS.minWidth}–{CANVAS_LIMITS.maxWidth}, height{" "}
                    {CANVAS_LIMITS.minHeight}–{CANVAS_LIMITS.maxHeight}, whole numbers only.
                  </p>
                  <Show when={canvasSummary()}>
                    {(text) => <p class="canvas-summary">{text()}</p>}
                  </Show>
                </div>

                <div class="field">
                  <label class="checkbox-row">
                    <input
                      type="checkbox"
                      checked={fpsCapOn()}
                      onChange={(e) => {
                        setFpsCapOn(e.currentTarget.checked);
                        setCanvasIssues({});
                        if (e.currentTarget.checked && fpsCapText().trim() === "") {
                          setFpsCapText(String(DEFAULT_FPS_CAP));
                        }
                      }}
                    />
                    <span>Limit the frame rate</span>
                  </label>

                  <Show when={fpsCapOn()}>
                    <div class="fps-row">
                      <input
                        id="canvas-fps-cap"
                        type="number"
                        inputmode="numeric"
                        aria-label="Frames per second"
                        min={CANVAS_LIMITS.minFpsCap}
                        max={CANVAS_LIMITS.maxFpsCap}
                        step={1}
                        class={fpsCapIssue() || canvasIssues()["fpsCap"] ? "invalid" : undefined}
                        value={fpsCapText()}
                        onInput={(e) => {
                          setFpsCapText(e.currentTarget.value);
                          setCanvasIssues({});
                        }}
                      />
                      <span class="faint">frames per second</span>
                    </div>
                  </Show>
                  <Show when={fpsCapIssue() ?? canvasIssues()["fpsCap"]}>
                    {(m) => <p class="field-error">{m()}</p>}
                  </Show>

                  <p class="field-help">
                    The idea: a slow-moving background does not need 60 frames a second, and every
                    frame it skips is graphics-card time the game being streamed keeps. Thirty is a
                    good number for anything ambient.
                  </p>
                  <p class="field-help">
                    <strong>Read this before relying on it.</strong> The cap is validated, stored
                    and handed to the effect, but <em>nothing enforces it yet</em>: all six effects
                    in this build run their own animation loops and ignore the value. The shared
                    frame loop that will honour it is a later piece of work (roadmap item 3.1).
                    Setting it today records your intention and changes nothing on screen. Width and
                    height, by contrast, take effect immediately.
                  </p>
                </div>
              </div>

              <div class="card">
                <div class="card-title">
                  <h2>Effect</h2>
                  <Show when={descriptor()}>{(d) => <span class="faint mono">{d().id}</span>}</Show>
                </div>
                <EffectPicker groups={groups} selectedId={effectId()} onSelect={chooseEffect} />
                <Show when={descriptor()?.previewNotes}>
                  {(notes) => <p class="field-help">{notes()}</p>}
                </Show>
              </div>

              {/*
                Presets sit directly above the parameters they replace, so that "apply" and the
                inputs it changes are visible at the same time. The card is handed the descriptor
                rather than an effect id: with no effect chosen there is nothing a preset could
                belong to, and a preset from another effect is not something the operator can pick
                — see the note at the top of RoutePresets.tsx.
              */}
              <RoutePresets
                descriptor={descriptor()}
                values={values()}
                onApply={(next) => {
                  setValues(next);
                  // The old messages described the values that were just replaced.
                  setFieldIssues({});
                  setSaved(null);
                }}
              />

              <div class="card">
                <div class="card-title">
                  <h2>Parameters</h2>
                  <Show when={descriptor()}>
                    <button
                      type="button"
                      class="btn btn-sm"
                      onClick={() => {
                        const spec = descriptor();
                        if (spec) setValues(mergeParams(spec, {}));
                      }}
                    >
                      Reset to defaults
                    </button>
                  </Show>
                </div>
                <Show
                  when={descriptor()}
                  fallback={<p class="faint">Choose an effect to see its parameters.</p>}
                >
                  {(spec) => (
                    <ParamsForm
                      descriptor={spec()}
                      values={values()}
                      issues={fieldIssues()}
                      onChange={setValues}
                    />
                  )}
                </Show>
              </div>

              <div class="card">
                <div class="btn-row">
                  <button type="submit" class="btn btn-primary" disabled={!canSave()}>
                    {saving()
                      ? "Saving…"
                      : props.mode === "create"
                        ? "Create route"
                        : "Save changes"}
                  </button>
                  <button type="button" class="btn" onClick={() => navigate("/admin")}>
                    Back to routes
                  </button>
                  <Show when={props.mode === "edit" && params.id}>
                    {(id) => (
                      <a class="btn" href={`/admin/routes/new?from=${encodeURIComponent(id())}`}>
                        Duplicate
                      </a>
                    )}
                  </Show>
                  <Show when={props.mode === "edit" && slugValid()}>
                    <a class="btn" href={`/e/${slug()}`} target="_blank" rel="noreferrer">
                      Open the OBS URL
                    </a>
                  </Show>
                </div>
              </div>
            </div>

            {/* -------- right column: the live preview -------- */}
            <aside class="preview-sticky">
              <div class="card">
                <div class="card-title">
                  <h2>Live preview</h2>
                  <span class="faint">16:9</span>
                </div>
                <div class="preview-stage">
                  <Show
                    when={selectedModule()}
                    fallback={
                      <div class="preview-note">
                        {effectId()
                          ? `This build has no implementation for “${effectId()}”.`
                          : "Pick an effect to preview it here."}
                      </div>
                    }
                  >
                    {(module) => (
                      /*
                       * The preview deliberately ignores both `enabled` and the canvas size.
                       *
                       * `enabled` because you have to see what you are editing — a route switched
                       * off is exactly the one you most need to look at before switching it back
                       * on. The canvas size because this pane is a fluid 16:9 box, not a browser
                       * source: passing no width or height lets `EffectStage` measure and observe
                       * itself, which is what makes the preview follow the browser window.
                       */
                      <EffectStage
                        class="preview-host"
                        module={module()}
                        params={values()}
                        fpsCap={canvasValue()?.fpsCap ?? null}
                      />
                    )}
                  </Show>
                </div>
                <p class="field-help">
                  The checkerboard is what OBS sees through: wherever it shows, the effect is
                  transparent and the scene underneath comes through.
                </p>
              </div>
            </aside>
          </form>
        </Loading>
      </Errored>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Duplicating a route                                                 */
/* ------------------------------------------------------------------ */

/**
 * Loads the route being duplicated and hands back a copy with a slug nothing is using yet.
 *
 * The route list is fetched alongside it purely to know which slugs are taken. If that request
 * fails the copy still opens — it falls back to suggesting `<slug>-copy` and letting the server
 * answer `409 SLUG_CONFLICT` if that is taken, which the form already turns into a message under
 * the slug field. A failed *side* request must not stop the operator from duplicating.
 */
async function loadDuplicateSource(id: string): Promise<RouteConfig> {
  const source = await getRoute(id);

  let taken: string[] = [];
  try {
    taken = (await listRoutes()).map((route) => route.slug);
  } catch (error) {
    console.warn("[editor] Could not list routes to pick a free slug for the copy.", error);
  }

  return { ...source, slug: duplicateSlug(source.slug, new Set(taken)) };
}

/**
 * Invents the slug for a duplicate: `main-camera` becomes `main-camera-copy`, then
 * `main-camera-copy-2`, `main-camera-copy-3`, … until one is free.
 *
 * ## Why this is in the frontend and not an endpoint
 *
 * There is deliberately no `POST /api/routes/{id}/duplicate`. Two reasons, and the second is the
 * real one:
 *
 * 1. A server endpoint would have to invent this name itself, which means teaching the backend a
 *    naming convention whose only purpose is to be looked at and edited by a person.
 * 2. Nobody duplicates a route in order to own two identical routes. They duplicate it to make
 *    "the same, but blue" — so the very next thing they want is the form, open, with the values in
 *    it. The endpoint would save one HTTP call and then land them on this screen anyway.
 *
 * Two details worth knowing:
 *
 * - A slug is at most 64 characters, so the base is trimmed to make room for the suffix rather
 *   than producing a name the backend will refuse.
 * - An existing `-copy` or `-copy-7` ending is stripped first, so duplicating a duplicate gives
 *   `…-copy-2` rather than `…-copy-copy`.
 */
function duplicateSlug(source: string, taken: ReadonlySet<string>): string {
  const base = source.replace(/-copy(-\d+)?$/, "");
  let candidate = "";
  // 200 is far past the point where somebody would keep clicking; the loop needs *some* end, and
  // returning the last candidate lets the server have the final word rather than hanging here.
  for (let n = 1; n <= 200; n++) {
    const suffix = n === 1 ? "-copy" : `-copy-${n}`;
    candidate = `${trimSlugTo(base, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return candidate;
}

/** Cuts a slug to at most `max` characters without leaving a trailing hyphen behind. */
function trimSlugTo(slug: string, max: number): string {
  return slug.length <= max ? slug : slug.slice(0, Math.max(1, max)).replace(/-+$/, "");
}

/* ------------------------------------------------------------------ */
/* Canvas number parsing                                               */
/* ------------------------------------------------------------------ */

/**
 * Reads a whole number out of what an operator typed, or `null` if that is not what they typed.
 *
 * The regular expression is stricter than `Number()` on purpose. `Number("")` is 0, `Number("1e3")`
 * is 1000 and `Number("  ")` is 0 — every one of which would turn a mistake into a
 * plausible-looking value. The backend answers `422` for a non-integer canvas number rather than
 * `400`, precisely because "not whole" is a fact about the value; this check is the same rule,
 * applied before the round trip.
 *
 * A leading minus **is** accepted even though no canvas number may be negative. That is so that
 * typing `-5` produces "must be between 16 and 7680", which says what to do about it, rather than
 * "must be a whole number", which is true of `-5` and therefore confusing.
 */
function parseWholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** The message for one out-of-range or unparseable canvas number, or `null` when it is fine. */
function describeRange(text: string, min: number, max: number, label: string): string | null {
  const value = parseWholeNumber(text);
  if (value === null) return `${label} must be a whole number.`;
  if (value < min || value > max) return `${label} must be between ${min} and ${max}.`;
  return null;
}
