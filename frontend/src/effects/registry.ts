/**
 * The effect registry.
 *
 * `./index.ts` (owned by the effects agent) exports one array:
 *
 *     export const effects: EffectModule[] = [ ... ];
 *
 * This file turns that flat array into the things the rest of the app needs:
 *
 *   - `getEffect(id)`      — look up one implementation by its descriptor id,
 *   - `listDescriptors()`  — the metadata for the admin UI, sorted by name,
 *   - `buildManifest()`    — the payload for `POST /api/effects/sync`,
 *   - `publishManifest()`  — actually send it, once, at application boot,
 *   - `mergeParams()`      — descriptor defaults overwritten by a route's sparse values.
 *
 * The import is *eager* (a plain `import`, not `import()`), so every effect is part of the main
 * bundle. That is deliberate: the renderer page must be able to mount an effect the instant the
 * route arrives, with no extra network round-trip while OBS is live.
 */

import { effects as effectModules } from "./index";
import type { EffectDescriptor, EffectModule } from "./types";
import { syncEffects } from "~/api/client";
import type { EffectSyncResponse } from "~/types/contract";

/**
 * Every module, indexed by `descriptor.id`.
 *
 * Built once when this module is first imported. If two modules claim the same id one would
 * silently shadow the other, so that case is reported loudly instead (see below).
 */
const byId: Map<string, EffectModule> = buildIndex(effectModules);

/** Ids that appeared more than once in `./index.ts`. Surfaced in the admin's Inventory page. */
const duplicateIds: string[] = [];

function buildIndex(modules: EffectModule[]): Map<string, EffectModule> {
  const index = new Map<string, EffectModule>();
  for (const module of modules) {
    const id = module.descriptor.id;
    if (index.has(id)) {
      // A duplicate id means one effect is unreachable. Never fail the whole app for it —
      // OBS would show a blank source — but make it impossible to miss while developing.
      duplicateIds.push(id);
      console.error(
        `[effects] Duplicate effect id "${id}". Only the first module with this id is reachable. ` +
          `Fix the ids in src/effects/index.ts.`,
      );
      continue;
    }
    index.set(id, module);
  }
  return index;
}

/** Ids that were declared twice. Empty in a healthy build. */
export function listDuplicateIds(): string[] {
  return [...duplicateIds];
}

/** Looks up an implementation. Returns `undefined` when this build does not contain that effect. */
export function getEffect(id: string): EffectModule | undefined {
  return byId.get(id);
}

/** True when this build can render the given effect id. */
export function hasEffect(id: string): boolean {
  return byId.has(id);
}

/** Every implemented effect's metadata, sorted by name the same way `GET /api/effects` is. */
export function listDescriptors(): EffectDescriptor[] {
  return [...byId.values()]
    .map((module) => module.descriptor)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Every implemented module, in descriptor-name order. */
export function listModules(): EffectModule[] {
  return [...byId.values()].sort((a, b) =>
    a.descriptor.name.localeCompare(b.descriptor.name, undefined, { sensitivity: "base" }),
  );
}

/** Descriptors grouped by `category`, with categories and effects each sorted alphabetically. */
export function descriptorsByCategory(): Array<{ category: string; effects: EffectDescriptor[] }> {
  const groups = new Map<string, EffectDescriptor[]>();
  for (const descriptor of listDescriptors()) {
    const category = descriptor.category || "uncategorised";
    const bucket = groups.get(category);
    if (bucket) bucket.push(descriptor);
    else groups.set(category, [descriptor]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => ({ category, effects: list }));
}

/**
 * The exact array sent as `{ effects: [...] }` to `POST /api/effects/sync`.
 *
 * Sync is a full replacement, so this must be the complete list of what this build implements —
 * anything missing from it is deleted from the backend's inventory.
 */
export function buildManifest(): EffectDescriptor[] {
  return listDescriptors().map((descriptor) => ({
    ...descriptor,
    /*
     * `rebuild` is a renderer-only hint (see `ParamSpec.rebuild` in `~/types/contract`). Stripping
     * it here is what lets that field's claim — "this never travels on the wire" — stay true
     * without a single line of Scala changing.
     *
     * Leaving it in would in fact decode fine, because the backend's JSON decoders ignore keys they
     * do not know about. Three lines to keep the request byte-identical to `docs/CONTRACT.md` is
     * worth more than relying on that.
     */
    params: descriptor.params.map(({ rebuild: _rebuild, ...spec }) => spec),
  }));
}

/**
 * A stable string built from the values of the parameters that declare `rebuild: true`, and from
 * nothing else.
 *
 * `EffectStage` compares this string across parameter changes: when it changes, the effect is
 * disposed and remounted; when it does not, the change goes to the running effect through
 * `setParams` as usual. Returns the empty string for an effect that declares no rebuild parameters,
 * which is every effect in this build today — so the remount path costs those effects nothing.
 *
 * `JSON.stringify` is used on each value for the same reason `sparseParams` below uses it: a
 * `default` may hold an array or an object, and `String(value)` would flatten two different arrays
 * to the same text.
 *
 * The separator is a NUL character because it cannot appear in a JSON string literal, so no
 * combination of values can forge a boundary and make two different parameter sets produce the same
 * key.
 */
export function rebuildKey(descriptor: EffectDescriptor, merged: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const spec of descriptor.params) {
    if (spec.rebuild !== true) continue;
    parts.push(`${spec.key}=${JSON.stringify(merged[spec.key])}`);
  }
  return parts.join("\u0000");
}

/**
 * Merges an effect's declared defaults with a route's stored values.
 *
 * The contract calls `RouteConfig.params` **sparse**: it only holds what the admin actually set.
 * Effects, on the other hand, are promised a complete parameter set. This function is the bridge:
 * start from every `ParamSpec.default`, then overwrite with the route's values.
 *
 * Keys in `routeParams` that the descriptor does not declare are ignored — the backend rejects
 * them at write time, but an effect removed from a newer build can leave stale keys behind in a
 * route saved earlier, and the renderer must not pass those on.
 */
export function mergeParams(
  descriptor: EffectDescriptor,
  routeParams: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const spec of descriptor.params) {
    merged[spec.key] = spec.default;
  }
  if (routeParams) {
    for (const spec of descriptor.params) {
      if (Object.prototype.hasOwnProperty.call(routeParams, spec.key)) {
        merged[spec.key] = routeParams[spec.key];
      }
    }
  }
  return merged;
}

/**
 * Strips a full parameter set back down to the sparse form the API stores.
 *
 * The admin form always works with complete values (every input has something in it), but saving
 * all of them would freeze today's defaults into the route forever: changing a default in the
 * effect's code would then have no effect on existing routes. So only values that actually differ
 * from the descriptor default are sent.
 */
export function sparseParams(
  descriptor: EffectDescriptor,
  fullParams: Record<string, unknown>,
): Record<string, unknown> {
  const sparse: Record<string, unknown> = {};
  for (const spec of descriptor.params) {
    const value = fullParams[spec.key];
    if (value === undefined) continue;
    // JSON comparison keeps this correct for the array/object values a `default` may hold.
    if (JSON.stringify(value) !== JSON.stringify(spec.default)) {
      sparse[spec.key] = value;
    }
  }
  return sparse;
}

/** Remembers the in-flight or finished publish so a second call is a no-op. */
let publishPromise: Promise<EffectSyncResponse | null> | null = null;

/**
 * Publishes this build's manifest to the backend, exactly once per page load.
 *
 * ## Where it is called from, and why that is not negotiable
 *
 * It is called by `SignedInArea` inside `src/components/AdminShell.tsx` — that is, from the admin
 * only, and only once the session check has passed.
 *
 * It used to be called at module scope in `src/index.tsx`, which meant on *every* page load,
 * including `/e/:slug` inside OBS. Since Phase 2 the endpoint it uses, `POST /api/effects/sync`,
 * requires a session, so left there it would make every OBS browser source fire a request that
 * comes back `401`, on every load, for the length of a broadcast. If you are moving this call,
 * keep it behind the admin's session gate.
 *
 * It never rejects: if the backend is down, the admin UI must still open (and show its own
 * connection error) rather than refusing to render.
 *
 * Returns the sync response, or `null` when the publish failed or was skipped.
 */
export function publishManifest(): Promise<EffectSyncResponse | null> {
  if (publishPromise) return publishPromise;

  publishPromise = (async () => {
    const manifest = buildManifest();
    if (manifest.length === 0) {
      // An empty manifest would wipe the backend inventory. That is almost never what you want
      // during development, when `src/effects/index.ts` may simply not be filled in yet.
      console.warn(
        "[effects] No effects are registered in src/effects/index.ts — skipping /api/effects/sync " +
          "so the existing backend inventory is not erased.",
      );
      return null;
    }
    try {
      const result = await syncEffects(manifest);
      console.info(
        `[effects] Synced inventory: ${result.upserted} upserted, ${result.removed} removed, ` +
          `${result.total} total.`,
      );
      return result;
    } catch (error) {
      console.error("[effects] Could not publish the effect manifest to the backend.", error);
      return null;
    }
  })();

  return publishPromise;
}
