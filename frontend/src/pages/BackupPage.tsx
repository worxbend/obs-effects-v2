import { createMemo, createSignal, Errored, For, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { describeError, exportBackup, importBackup, listPresets, listRoutes } from "~/api/client";
import { hasEffect } from "~/effects/registry";
import {
  normaliseCanvas,
  SLUG_PATTERN,
  type CanvasSettings,
  type ImportMode,
  type ImportPreset,
  type ImportRequest,
  type ImportResult,
  type ImportRoute,
  type Preset,
  type RouteConfig,
} from "~/types/contract";
import { Banner } from "~/components/Banner";

/** The only schema version this build reads and writes. */
const SCHEMA_VERSION = 1;

/**
 * An import file that has been read and understood, ready to be sent.
 *
 * `warnings` are things the *server* will judge — an effect this build does not implement, a slug
 * that does not match the pattern. They are shown, not enforced: the backend is the authority on
 * what it will accept, and a client that refuses a file the server would have taken is a client
 * that has to be worked around.
 */
interface StagedFile {
  name: string;
  exportedAt: string | null;
  routes: ImportRoute[];
  presets: ImportPreset[];
  warnings: string[];
}

/** What `parseImportFile` produces: either a usable file or the reasons it is not one. */
type ParseResult = { ok: true; file: StagedFile } | { ok: false; problems: string[] };

/**
 * `/admin/backup` — download everything, and put it back again.
 *
 * This is the backup story for the whole tool. Every route and every preset lives in one MongoDB
 * volume; losing that volume loses every scene you ever set up, and until this page existed there
 * was no way to keep a copy.
 *
 * Effects are deliberately not part of a backup. They are code in this frontend bundle, republished
 * to the backend on every admin page load, so a file containing effect descriptors would only be a
 * way for a restore to contradict the build that is actually running.
 */
export default function BackupPage(): JSX.Element {
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Backup</h1>
          <p>
            Download every route and preset as one JSON file, and restore that file later. This is
            the only copy of your configuration that lives outside the database container, so a
            fresh download after a session of setting scenes up is worth the ten seconds.
          </p>
        </div>
      </div>

      <ExportCard />
      <ImportCard />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function ExportCard(): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const envelope = await exportBackup();
      const name = exportFileName(envelope.exportedAt);
      saveJsonFile(name, envelope);
      setDone(
        `Saved ${countLabel(envelope.routes.length, "route")} and ` +
          `${countLabel(envelope.presets.length, "preset")} to ${name}.`,
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="card">
      <div class="card-title">
        <h2>Export</h2>
      </div>

      <Banner kind="error" message={error()} />
      <Banner kind="ok" message={done()} />

      <p class="field-help">
        The file contains every route — slug, effect, parameters, canvas settings and enabled flag —
        and every preset, with the timestamps they were created and last changed at. It is ordinary
        JSON, so it can be read, edited in a text editor, and kept in version control alongside the
        rest of your streaming setup.
      </p>

      <div class="btn-row">
        <button type="button" class="btn btn-primary" disabled={busy()} onClick={() => void save()}>
          {busy() ? "Preparing…" : "Download backup"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

function ImportCard(): JSX.Element {
  const [staged, setStaged] = createSignal<StagedFile | null>(null);
  const [problems, setProblems] = createSignal<string[]>([]);
  const [reading, setReading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<ImportResult | null>(null);

  /**
   * What is in the database right now.
   *
   * This is read so the confirmation can say what the import will actually do to *this* database —
   * "3 routes overwritten, 1 created" rather than "9 routes imported". An async memo, so reading it
   * suspends inside the `<Loading>` below and throws inside the `<Errored>`.
   */
  const current = createMemo<[RouteConfig[], Preset[]]>(() =>
    Promise.all([listRoutes(), listPresets()]),
  );

  const chooseFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    // Clear the element's own value so that picking the same file again after a cancel still
    // fires a change event. Without this, "choose the file, cancel, choose it again" does nothing.
    input.value = "";
    if (!file) return;

    setReading(true);
    setError(null);
    setResult(null);
    setStaged(null);
    setProblems([]);
    try {
      const parsed = parseImportFile(file.name, await file.text());
      if (parsed.ok) setStaged(parsed.file);
      else setProblems(parsed.problems);
    } catch (e) {
      setError(`That file could not be read: ${describeError(e)}`);
    } finally {
      setReading(false);
    }
  };

  return (
    <div class="card">
      <div class="card-title">
        <h2>Import</h2>
      </div>

      <Banner kind="error" message={error()} />

      <p class="field-help">
        Choose an export file. Nothing is sent anywhere until you have read what it is going to do
        and pressed the confirmation button — picking a file only reads it here in the browser.
      </p>

      <div class="field">
        <label class="field-label" for="import-file">
          Backup file
        </label>
        <input
          id="import-file"
          type="file"
          accept="application/json,.json"
          disabled={reading()}
          onChange={(e) => void chooseFile(e.currentTarget)}
        />
      </div>

      <Show when={problems().length > 0}>
        <div class="banner banner-error" role="alert">
          <p>This file cannot be imported:</p>
          <ul class="issue-list">
            <For each={problems()}>{(problem) => <li>{problem}</li>}</For>
          </ul>
        </div>
      </Show>

      <Show when={result()}>
        {(counts) => (
          <div class="banner banner-ok" role="status">
            <p>Import finished.</p>
            <ul class="issue-list">
              <li>
                Routes: {counts().routesCreated} created, {counts().routesUpdated} updated,{" "}
                {counts().routesDeleted} deleted.
              </li>
              <li>
                Presets: {counts().presetsCreated} created, {counts().presetsUpdated} updated,{" "}
                {counts().presetsDeleted} deleted.
              </li>
            </ul>
            <p>
              Live browser sources were told about every change as it happened, so anything showing
              one of these slugs has already followed the restore.
            </p>
          </div>
        )}
      </Show>

      <Show when={staged()}>
        {(file) => (
          <Errored
            fallback={(failure) => (
              <Banner
                kind="error"
                message={`Could not read what is currently stored, so this import cannot be described before it happens: ${describeError(failure())}`}
              />
            )}
          >
            <Loading fallback={<p class="muted">Comparing the file with what is stored…</p>}>
              <ImportPlan
                file={file()}
                stored={current()}
                onImported={(counts) => {
                  setResult(counts);
                  setStaged(null);
                }}
                onCancel={() => setStaged(null)}
              />
            </Loading>
          </Errored>
        )}
      </Show>
    </div>
  );
}

/**
 * The confirmation step: what this file will do to this database, in plain words, before it does
 * it.
 *
 * This is deliberately not a `window.confirm`. A native dialog can hold one line of text, cannot
 * show the numbers below, blocks the whole browser thread while it is open, and cannot be styled
 * or tested. An import can delete every scene an operator has; it earns a proper explanation, in
 * the page, with the numbers worked out against what is actually stored.
 */
function ImportPlan(props: {
  file: StagedFile;
  /** Everything currently stored: `[routes, presets]`, as `Promise.all` returns it. */
  stored: [RouteConfig[], Preset[]];
  onImported(result: ImportResult): void;
  onCancel(): void;
}): JSX.Element {
  /*
   * `mode` starts as null — no default, and the confirmation button stays disabled until one is
   * chosen. The contract makes the field required for the same reason: "merge" and "replace"
   * differ by "nothing is deleted" versus "everything is deleted first", and a client that did not
   * say which one it meant is a client whose intention nobody knows.
   */
  const [mode, setMode] = createSignal<ImportMode | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const storedRoutes = () => props.stored[0];
  const storedPresets = () => props.stored[1];

  /** File entries split into "this already exists here" and "this is new". */
  const plan = createMemo(() => {
    const slugs = new Set(storedRoutes().map((route) => route.slug));
    const presetKeys = new Set(storedPresets().map(presetKey));
    const routesMatched = props.file.routes.filter((route) => slugs.has(route.slug)).length;
    const presetsMatched = props.file.presets.filter((preset) =>
      presetKeys.has(presetKey(preset)),
    ).length;
    return {
      routesMatched,
      routesNew: props.file.routes.length - routesMatched,
      presetsMatched,
      presetsNew: props.file.presets.length - presetsMatched,
      /** Stored routes this file says nothing about — the ones "replace" would remove. */
      routesUnmentioned:
        storedRoutes().length -
        storedRoutes().filter((route) => props.file.routes.some((r) => r.slug === route.slug))
          .length,
      presetsUnmentioned:
        storedPresets().length -
        storedPresets().filter((preset) =>
          props.file.presets.some((p) => presetKey(p) === presetKey(preset)),
        ).length,
    };
  });

  const run = async () => {
    const chosen = mode();
    if (!chosen) return;

    const body: ImportRequest = {
      schemaVersion: SCHEMA_VERSION,
      mode: chosen,
      routes: props.file.routes,
      presets: props.file.presets,
    };

    setBusy(true);
    setError(null);
    try {
      props.onImported(await importBackup(body));
    } catch (e) {
      // A 422 means the server validated the whole file and wrote nothing, so saying "nothing was
      // changed" is a fact rather than a hope. `describeError` appends the field-level issues,
      // whose paths point into the file: `routes[3].slug`.
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="import-plan">
      <Banner kind="error" message={error()} />

      <p>
        <strong>{props.file.name}</strong> holds {countLabel(props.file.routes.length, "route")} and{" "}
        {countLabel(props.file.presets.length, "preset")}.
      </p>
      <Show when={props.file.exportedAt}>
        {(at) => <p class="field-help">The file says it was exported {formatTime(at())}.</p>}
      </Show>

      <Show when={props.file.warnings.length > 0}>
        <div class="banner banner-info" role="status">
          <p>Worth knowing before you import:</p>
          <ul class="issue-list">
            <For each={props.file.warnings}>{(warning) => <li>{warning}</li>}</For>
          </ul>
        </div>
      </Show>

      <fieldset class="mode-choice">
        <legend class="field-label">What should happen to what is already here?</legend>

        <label class="checkbox-row">
          <input
            type="radio"
            name="import-mode"
            value="merge"
            checked={mode() === "merge"}
            onChange={() => setMode("merge")}
          />
          <span>
            <strong>Merge</strong> — nothing is deleted.
          </span>
        </label>
        <p class="field-help mode-help">
          A route in the file is matched to a stored one by its <em>slug</em>, and a preset by its
          effect and name. {countLabel(plan().routesMatched, "route")} and{" "}
          {countLabel(plan().presetsMatched, "preset")} in this file already exist here and would be
          overwritten; {countLabel(plan().routesNew, "route")} and{" "}
          {countLabel(plan().presetsNew, "preset")} would be created. Everything else you have stays
          exactly as it is.
        </p>

        <label class="checkbox-row">
          <input
            type="radio"
            name="import-mode"
            value="replace"
            checked={mode() === "replace"}
            onChange={() => setMode("replace")}
          />
          <span>
            <strong>Replace</strong> — everything stored now is deleted first.
          </span>
        </label>
        <p class="field-help mode-help">
          All {countLabel(storedRoutes().length, "route")} and{" "}
          {countLabel(storedPresets().length, "preset")} currently stored are deleted, then this
          file is inserted. {countLabel(plan().routesUnmentioned, "route")} and{" "}
          {countLabel(plan().presetsUnmentioned, "preset")} that this file does not mention would be
          gone for good. The database is the only copy, so download a backup first if you have not.
        </p>
      </fieldset>

      <Show when={mode() === "replace"}>
        <div class="banner banner-error" role="alert">
          This deletes {countLabel(storedRoutes().length, "route")} and{" "}
          {countLabel(storedPresets().length, "preset")}, including{" "}
          {countLabel(plan().routesUnmentioned, "route")} not present in this file. An OBS source
          pointed at one of those slugs goes blank the moment this runs.
        </div>
      </Show>

      <p class="field-help">
        The server checks the whole file before it writes anything, so a file with a problem in it
        changes nothing at all. It cannot, however, undo a restore that stops halfway: the database
        runs as a single node, which has no multi-document transactions. If that happens, running
        the same import again repairs it — for one file, both modes give the same result however
        many times you run them.
      </p>

      <div class="btn-row">
        <button
          type="button"
          class={["btn", mode() === "replace" ? "btn-danger" : "btn-primary"]}
          disabled={mode() === null || busy()}
          onClick={() => void run()}
        >
          {busy()
            ? "Importing…"
            : mode() === "replace"
              ? "Yes, delete everything and import"
              : mode() === "merge"
                ? "Yes, merge this file in"
                : "Choose merge or replace first"}
        </button>
        <button type="button" class="btn" disabled={busy()} onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reading an import file                                              */
/* ------------------------------------------------------------------ */

/**
 * Turns the text of a chosen file into something that can be sent, or into the list of reasons it
 * cannot be.
 *
 * The split between a *problem* and a *warning* is deliberate and worth keeping:
 *
 *  - A **problem** means this text cannot be turned into a request at all — it is not JSON, it is
 *    not an object, a route has no slug. Reporting these here saves a round trip that could only
 *    end in a 400.
 *  - A **warning** means the *server* will judge it: an effect this build does not implement, a
 *    slug that breaks the pattern. Those are shown next to the confirmation button but never block
 *    it, because the backend is the authority on what it accepts and a frontend that refuses a
 *    file the backend would have taken is a frontend somebody has to work around.
 *
 * Unknown keys are dropped rather than forwarded: what this function builds is exactly the fields
 * the contract defines, so a typo in a hand-edited file (`slugg`) becomes a missing `slug` you are
 * told about, instead of an extra field the server silently ignores.
 */
function parseImportFile(name: string, text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      problems: [`${name} is not valid JSON. An export file is a single JSON object.`],
    };
  }

  const envelope = asRecord(parsed);
  if (!envelope) {
    return { ok: false, problems: [`${name} does not contain a JSON object at the top level.`] };
  }

  const problems: string[] = [];
  const warnings: string[] = [];

  const schemaVersion = envelope["schemaVersion"];
  if (schemaVersion !== SCHEMA_VERSION) {
    problems.push(
      `This build reads schemaVersion ${SCHEMA_VERSION} only, and the file says ` +
        `${JSON.stringify(schemaVersion)}.`,
    );
  }

  const routes = readRoutes(envelope["routes"], problems, warnings);
  const presets = readPresets(envelope["presets"], problems, warnings);

  const exportedAt = typeof envelope["exportedAt"] === "string" ? envelope["exportedAt"] : null;

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, file: { name, exportedAt, routes, presets, warnings } };
}

/** Reads and checks the `routes` array, appending to `problems` / `warnings` as it goes. */
function readRoutes(raw: unknown, problems: string[], warnings: string[]): ImportRoute[] {
  if (!Array.isArray(raw)) {
    problems.push("The file has no `routes` array. An export always has one, even when empty.");
    return [];
  }

  const routes: ImportRoute[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const where = `routes[${index}]`;
    const record = asRecord(entry);
    if (!record) {
      problems.push(`${where} is not an object.`);
      return;
    }

    const slug = record["slug"];
    const effectId = record["effectId"];
    if (typeof slug !== "string" || slug === "") {
      problems.push(`${where}.slug is missing or is not text.`);
      return;
    }
    if (typeof effectId !== "string" || effectId === "") {
      problems.push(`${where}.effectId is missing or is not text.`);
      return;
    }

    if (seen.has(slug)) {
      // The server rejects a file that lists the same slug twice, because merging a file against
      // itself has no defined answer. Saying so now is better than a 422 after the upload.
      problems.push(`${where}.slug “${slug}” appears more than once in this file.`);
      return;
    }
    seen.add(slug);

    if (!SLUG_PATTERN.test(slug)) {
      warnings.push(
        `${where}.slug “${slug}” is not a valid slug (lowercase letters, digits and hyphens, ` +
          `1–64 characters), so the server will refuse this file.`,
      );
    }
    if (!hasEffect(effectId)) {
      warnings.push(
        `${where} uses the effect “${effectId}”, which this build does not implement, so the ` +
          `server will refuse this file. Restore that effect's code first.`,
      );
    }

    const route: ImportRoute = {
      slug,
      effectId,
      // A file that says nothing about `enabled` gets a route that is on. That is what an operator
      // hand-writing a file means, and the alternative — a route that exists but draws nothing —
      // looks exactly like a broken import.
      enabled: typeof record["enabled"] === "boolean" ? record["enabled"] : true,
      params: asRecord(record["params"]) ?? {},
    };

    /*
     * The canvas is only sent when the file has one, so that a file without it takes the server's
     * own defaults rather than this page's opinion of them. When it *is* present, `normaliseCanvas`
     * fills in whichever of the three fields a hand-edited file left out — it is the one place on
     * the client where canvas defaults are applied.
     */
    const canvas = readCanvas(asRecord(record["canvas"]));
    if (canvas) route.canvas = normaliseCanvas(canvas);

    // `createdAt` is the one server-assigned field the server reads back: a restore that reported
    // every scene as created today would throw information away for no reason.
    if (typeof record["createdAt"] === "string") route.createdAt = record["createdAt"];

    routes.push(route);
  });

  return routes;
}

/** Reads and checks the `presets` array, appending to `problems` / `warnings` as it goes. */
function readPresets(raw: unknown, problems: string[], warnings: string[]): ImportPreset[] {
  if (!Array.isArray(raw)) {
    problems.push("The file has no `presets` array. An export always has one, even when empty.");
    return [];
  }

  const presets: ImportPreset[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const where = `presets[${index}]`;
    const record = asRecord(entry);
    if (!record) {
      problems.push(`${where} is not an object.`);
      return;
    }

    const name = record["name"];
    const effectId = record["effectId"];
    if (typeof name !== "string" || name.trim() === "") {
      problems.push(`${where}.name is missing or is blank.`);
      return;
    }
    if (typeof effectId !== "string" || effectId === "") {
      problems.push(`${where}.effectId is missing or is not text.`);
      return;
    }

    const key = `${effectId}\u0000${name.trim().toLowerCase()}`;
    if (seen.has(key)) {
      problems.push(
        `${where}: “${name}” appears more than once for the effect “${effectId}”. Preset names ` +
          `are unique per effect, ignoring case.`,
      );
      return;
    }
    seen.add(key);

    if (!hasEffect(effectId)) {
      warnings.push(
        `${where} belongs to the effect “${effectId}”, which this build does not implement, so ` +
          `the server will refuse this file.`,
      );
    }

    const preset: ImportPreset = {
      name: name.trim(),
      effectId,
      params: asRecord(record["params"]) ?? {},
    };
    if (typeof record["createdAt"] === "string") preset.createdAt = record["createdAt"];

    presets.push(preset);
  });

  return presets;
}

/**
 * Picks the three canvas numbers out of a JSON object, ignoring anything that is not a number.
 *
 * Written out by hand rather than cast, because a cast would only be a claim: the values in a file
 * somebody edited really can be strings, and `normaliseCanvas` substitutes its default for each
 * one this drops.
 */
function readCanvas(raw: Record<string, unknown> | null): Partial<CanvasSettings> | null {
  if (!raw) return null;
  const canvas: Partial<CanvasSettings> = {};
  if (typeof raw["width"] === "number") canvas.width = raw["width"];
  if (typeof raw["height"] === "number") canvas.height = raw["height"];
  if (typeof raw["fpsCap"] === "number") canvas.fpsCap = raw["fpsCap"];
  return canvas;
}

/** A plain JSON object, or `null` for anything else — including `null` and an array. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * How a preset is matched to a stored one: its effect plus its name, ignoring case.
 *
 * The two halves are joined with `\u0000`, the NUL character, because it is the one character
 * that cannot appear in either half — so `{effectId: "a", name: "b-c"}` and `{effectId: "a-b",
 * name: "c"}` cannot collide into one key, which joining on a hyphen or a colon would allow.
 *
 * It is written as the escape `\u0000` rather than as a raw NUL byte typed into the file. A raw
 * NUL makes the whole source file count as *binary* to `grep`, `git diff`, code-review tools and
 * some editors: this file was in that state, and a plain `grep` for any name in it answered only
 * "binary file matches". The escape compiles to exactly the same single character.
 */
function presetKey(preset: { effectId: string; name: string }): string {
  return `${preset.effectId}\u0000${preset.name.trim().toLowerCase()}`;
}

/**
 * Hands the browser a file to save.
 *
 * There is no way to write to disk directly, and no reason to want one: an object URL is a
 * temporary address for a blob held in memory, and clicking an anchor that carries `download` makes
 * the browser save what is at that address under the given name. The anchor never appears on
 * screen — it is created, clicked and discarded within this function.
 *
 * The address is released on the next turn of the event loop rather than immediately. Revoking it
 * in the same tick as the click has been observed to cancel the download in some browsers, and an
 * address that lives one extra millisecond costs nothing.
 */
function saveJsonFile(name: string, content: unknown): void {
  // Two-space indentation, because the point of this file is that a person can open it.
  const blob = new Blob([JSON.stringify(content, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * `obs-effects-export-20260824-101112.json` — the same name the server puts in its
 * `Content-Disposition` header, built from the same timestamp so the two cannot drift apart.
 *
 * The time is UTC, which is what makes two backups taken either side of a daylight-saving change
 * sort in the order they were taken.
 */
function exportFileName(exportedAt: string): string {
  const when = new Date(exportedAt);
  const stamp = Number.isNaN(when.getTime()) ? new Date() : when;
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}`;
  const time = `${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}${pad(stamp.getUTCSeconds())}`;
  return `obs-effects-export-${date}-${time}.json`;
}

/** "1 route", "3 routes", "no routes" — so no sentence on this page reads "1 routes". */
function countLabel(count: number, noun: string): string {
  if (count === 0) return `no ${noun}s`;
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/** Shows "2026-08-23 14:07" in the viewer's own time zone instead of a raw ISO string. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
