import { createMemo, createSignal, Errored, For, Loading, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { deleteRoute, describeError, listRoutes } from "~/api/client";
import { getEffect } from "~/effects/registry";
import { Banner } from "~/components/Banner";
import { EnabledBadge, EngineBadge } from "~/components/Badges";
import type { RouteConfig } from "~/types/contract";

/**
 * `/admin` — the list of every configured route.
 *
 * A "route" is the mapping OBS points at: the slug `main-camera` means the URL
 * `http://localhost:3000/e/main-camera`, which never has to change once it is pasted into a
 * browser source.
 */
export default function RoutesListPage(): JSX.Element {
  /*
   * An **async memo**: a `createMemo` whose function returns a promise. Solid 2 has no
   * `createResource`; this is the replacement, and it is deliberately smaller. Reading `routes()`
   * while the request is in flight suspends, and the enclosing `<Loading>` shows its fallback;
   * if the request fails, reading throws and the enclosing `<Errored>` catches it.
   *
   * `listRoutes` takes an optional `AbortSignal`, so it is wrapped in an arrow function that takes
   * no arguments — handing it over directly would let the memo pass its own argument in.
   */
  const routes = createMemo(() => listRoutes());

  // Id of the route whose delete button was pressed. Showing the confirmation inline, in the row
  // itself, rather than through `window.confirm`, keeps the dialog inside the app's own styling
  // and keeps it testable — a native modal blocks the whole browser thread.
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const confirmDelete = async (route: RouteConfig) => {
    setBusyId(route.id);
    setError(null);
    try {
      await deleteRoute(route.id);
      setConfirmingId(null);
      /*
       * `refresh` re-runs an async memo's function — the replacement for the old resource's
       * `refetch()`. It invalidates rather than tears down, so the table stays on screen showing
       * the previous rows while the fresh list is fetched.
       */
      refresh(routes);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  };

  /** The human-readable effect name, or a warning when this build cannot render it. */
  const effectLabel = (effectId: string): JSX.Element => {
    const module = getEffect(effectId);
    if (!module) {
      return (
        <>
          <code>{effectId}</code> <span class="badge badge-missing">not implemented</span>
        </>
      );
    }
    return (
      <>
        {module.descriptor.name} <EngineBadge engine={module.descriptor.engine} />
      </>
    );
  };

  /** Shows "2026-08-23 14:07" in the viewer's own time zone instead of a raw ISO string. */
  const formatTime = (iso: string): string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  };

  return (
    <>
      <div class="page-head">
        <div>
          <h1>Routes</h1>
          <p>
            Each route is one OBS browser source. Point OBS at <code>/e/&lt;slug&gt;</code> once;
            everything you change here reaches the live source in well under a second, with no need
            to touch OBS again.
          </p>
        </div>
        <a href="/admin/routes/new" class="btn btn-primary">
          New route
        </a>
      </div>

      <Banner kind="error" message={error()} />

      {/*
        The two boundaries wrap only the part that reads `routes()`, never the heading above. If
        they wrapped the whole page, a refresh after a delete would replace the entire screen with
        "Loading routes…" instead of only the table.
      */}
      <Errored fallback={(failure) => <Banner kind="error" message={describeError(failure())} />}>
        <Loading fallback={<p class="muted">Loading routes…</p>}>
          <Show
            when={routes().length > 0}
            fallback={
              <div class="empty">
                <p>No routes yet.</p>
                <a href="/admin/routes/new" class="btn btn-primary">
                  Create the first one
                </a>
              </div>
            }
          >
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Slug</th>
                    <th>Effect</th>
                    <th>State</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={routes()}>
                    {(route) => (
                      <tr>
                        <td>
                          <code>/e/{route.slug}</code>
                        </td>
                        <td>{effectLabel(route.effectId)}</td>
                        <td>
                          <EnabledBadge enabled={route.enabled} />
                        </td>
                        <td class="faint">{formatTime(route.updatedAt)}</td>
                        <td>
                          <Show
                            when={confirmingId() === route.id}
                            fallback={
                              <div class="cell-actions">
                                <a href={`/admin/routes/${route.id}`} class="btn btn-sm">
                                  Edit
                                </a>
                                {/*
                                  "Duplicate" is a link, not a button, because duplicating is not
                                  a write: it opens the ordinary create form pre-filled from this
                                  route, with a free slug suggested, and nothing is stored until
                                  the operator presses "Create route". There is no duplicate
                                  endpoint on the backend for exactly that reason — see
                                  `duplicateSlug` in RouteEditorPage.tsx.
                                */}
                                <a
                                  href={`/admin/routes/new?from=${encodeURIComponent(route.id)}`}
                                  class="btn btn-sm"
                                >
                                  Duplicate
                                </a>
                                <a
                                  href={`/e/${route.slug}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  class="btn btn-sm"
                                >
                                  Open
                                </a>
                                <button
                                  type="button"
                                  class="btn btn-sm btn-danger"
                                  onClick={() => {
                                    setError(null);
                                    setConfirmingId(route.id);
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            }
                          >
                            <div class="confirm-row">
                              <span>Delete “{route.slug}” for good?</span>
                              <button
                                type="button"
                                class="btn btn-sm"
                                disabled={busyId() === route.id}
                                onClick={() => setConfirmingId(null)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                class="btn btn-sm btn-danger"
                                disabled={busyId() === route.id}
                                onClick={() => void confirmDelete(route)}
                              >
                                {busyId() === route.id ? "Deleting…" : "Yes, delete"}
                              </button>
                            </div>
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Loading>
      </Errored>
    </>
  );
}
