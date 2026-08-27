import { createMemo, createSignal, Loading, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation, useNavigate } from "@solidjs/router";
import { describeError, getHealth, logout, onUnauthorized } from "~/api/client";
import { forgetSession, loadSession, loginHref, needsSignIn } from "~/auth/session";
import { publishManifest } from "~/effects/registry";
import { Banner } from "~/components/Banner";

/**
 * The chrome around every admin page: the top bar, the navigation links, the backend health
 * indicator, the sign-out control — and the session check that decides whether any of it is shown
 * at all.
 *
 * `props.children` is whatever page the router matched.
 *
 * ## The renderer page is deliberately not wrapped in this
 *
 * `/e/:slug` is a route of its own, outside this component, and it must stay that way. OBS points
 * a browser source at that URL and leaves it running unattended for the length of a broadcast. It
 * has no way to sign in, no way to see a login form, and no person watching it — so everything in
 * this file (the session fetch, the redirect, the 401 handler, the manifest publish) must be
 * unreachable from there. Wrapping the renderer in the shell "for consistency" would take a live
 * layer off air the first time a session expired.
 *
 * The endpoints the renderer calls are public for the same reason; see the table in
 * `docs/CONTRACT.md` §4.
 */
export function AdminShell(props: { children?: JSX.Element }): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();

  /*
   * ── Central 401 handling ───────────────────────────────────────────────────────────────────
   *
   * Any protected call that comes back 401 means the session ended while this tab was open: it
   * expired, the operator signed out in another tab, or the backend restarted. There is nothing
   * useful a page can do about that on its own, so no page tries: the API client raises the event
   * and this one handler answers it, by sending the operator to the login page with a note of
   * where they were.
   *
   * Registering it here, rather than in `index.tsx` or in the client module itself, is what keeps
   * it away from `/e/:slug`. This component is mounted only for `/admin/*` paths, so while the
   * renderer page is on screen there is no handler installed at all — the exemption is structural
   * rather than a condition somebody has to remember to write. `onUnauthorized` returns its own
   * unregister function, which `onSettled` runs on unmount.
   */
  onSettled(() =>
    onUnauthorized(() => {
      forgetSession();
      navigate(loginHref(`${location.pathname}${location.search}`), { replace: true });
    }),
  );

  /*
   * An **async memo**: a `createMemo` whose function returns a promise. This is how asynchronous
   * data is loaded in Solid 2 — there is no `createResource` any more.
   *
   * Reading `session()` before the promise settles does not return `undefined`; it *suspends*, and
   * the nearest enclosing `<Loading>` shows its fallback until the value is there.
   *
   * `loadSession()` caches its answer for the life of the page and never rejects, so moving
   * between admin pages costs no extra request and a backend outage produces the value `null`
   * ("we could not ask") rather than an exception.
   */
  const session = createMemo(() => loadSession());

  /*
   * The same shape for the health indicator. The `.catch(() => null)` is deliberate: a backend
   * that is down is a normal, expected state for this widget, and turning it into a value rather
   * than an error is what lets the header say "unreachable" instead of blanking out.
   */
  const health = createMemo(() => getHealth().catch(() => null));

  /** True when the backend requires a password, so there is something to sign out of. */
  const showSignOut = createMemo(() => {
    const info = session();
    return info !== null && info !== undefined && info.authRequired && info.authenticated;
  });

  const [signingOut, setSigningOut] = createSignal(false);
  const [signOutError, setSignOutError] = createSignal<string | null>(null);

  const signOut = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await logout();
      forgetSession();
      navigate(loginHref(), { replace: true });
    } catch (e) {
      // Logout answers 204 even without a cookie, so the only way here is an unreachable backend.
      // Say so rather than pretending the operator is signed out when the server still thinks not.
      setSignOutError(describeError(e));
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div class="shell">
      <header class="topbar">
        <a href="/admin" class="brand">
          <span class="brand-dot" aria-hidden="true" />
          OBS Effects
        </a>

        {/*
          Plain <a> elements. Solid Router 2 removed the <A> component: it now watches clicks on
          ordinary anchors and marks the ones matching the current URL, so the "which tab am I on"
          highlight is styled in CSS (see `.nav a[aria-current="page"]` in styles/app.css) instead
          of being computed here.
        */}
        <nav class="nav">
          <a href="/admin">Routes</a>
          <a href="/admin/presets">Presets</a>
          <a href="/admin/effects">Inventory</a>
          <a href="/admin/backup">Backup</a>
          <a href="/admin/settings">Settings</a>
        </nav>

        <div class="topbar-status">
          <Loading
            fallback={
              <>
                <span class="status-dot" aria-hidden="true" />
                <span>checking backend…</span>
              </>
            }
          >
            <Show
              when={health()}
              fallback={
                <>
                  <span class="status-dot down" aria-hidden="true" />
                  <span>backend unreachable</span>
                </>
              }
            >
              {(info) => (
                <>
                  {/*
                    Solid 2's `class` prop takes an array of class names, not only a string; a
                    falsy entry contributes nothing, and an object entry contributes each key whose
                    value is true. Assembling the same string by hand with a template literal
                    works, but Solid then has to re-evaluate the whole template and rewrite the
                    element's class attribute whenever any part of it changes, where the array form
                    lets it toggle the single class that actually moved.
                  */}
                  <span
                    class={["status-dot", info().mongo === "up" ? "up" : "down"]}
                    aria-hidden="true"
                  />
                  <span>
                    mongo {info().mongo} · {info().effects} effects · {info().routes} routes
                  </span>
                </>
              )}
            </Show>
          </Loading>

          {/*
            The sign-out control is hidden when `authRequired` is false — a backend started with
            ADMIN_AUTH_DISABLED=true has no session to end, and a button that cannot do anything is
            worse than no button. It is inside its own <Loading> so the header does not wait for
            the session answer before drawing the health readout.
          */}
          <Loading fallback={null}>
            <Show when={showSignOut()}>
              <button
                type="button"
                class="btn btn-sm"
                disabled={signingOut()}
                onClick={() => void signOut()}
              >
                {signingOut() ? "Signing out…" : "Sign out"}
              </button>
            </Show>
          </Loading>
        </div>
      </header>

      <main class="page">
        <Banner kind="error" message={signOutError()} />

        {/*
          ── The session gate ──────────────────────────────────────────────────────────────────

          Everything below waits for `GET /api/auth/session`. That is one request, once per page
          load, and it is what stops two annoyances the operator would otherwise hit: a signed-in
          operator pressing F5 must not be flashed the login screen while the answer is in flight,
          and a session that quietly expired overnight should be discovered before somebody fills
          in a long form and loses it on save.

          `needsSignIn` treats "we could not reach the backend" as *not* a reason to redirect — see
          the comment on it. A login page that cannot submit is a worse answer than a page that
          says the backend is down.
        */}
        <Loading fallback={<p class="muted">Checking your session…</p>}>
          <Show when={!needsSignIn(session())} fallback={<RedirectToLogin />}>
            <SignedInArea>{props.children}</SignedInArea>
          </Show>
        </Loading>
      </main>
    </div>
  );
}

/**
 * Sends the operator to the login page, remembering where they were.
 *
 * Solid Router used to ship a `<Navigate href="…" />` component for this. It no longer exists, and
 * the documented replacement is to call `useNavigate()` while the component is being set up —
 * which is what this does. It draws nothing, so it returns `null`.
 *
 * ## Why the location is read inside `untrack`
 *
 * `location.pathname` and `location.search` are *reactive* values: reading one inside a tracking
 * scope subscribes to it, so that the scope re-runs when it changes. This component has no such
 * scope — it reads them once, in its body, to decide where to send the operator, and then it is
 * finished. Reading a reactive value in a place that will never re-run is exactly what Solid 2's
 * development build warns about with `[STRICT_READ_UNTRACKED] Reactive value read directly in
 * <RedirectToLogin> will not update`, and that warning was printed on every redirect to the login
 * page in the build `make up` serves.
 *
 * The read is correct and deliberate — the URL cannot change between this line and the `navigate`
 * on the next one — so the fix is to say so rather than to restructure. `untrack` is the library's
 * own way of saying "this read is on purpose"; it returns the same value and subscribes to
 * nothing. Phase 1 used it for the two equivalent reads in `EffectStage.tsx`, and this is the same
 * situation in a different file.
 */
function RedirectToLogin(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const target = untrack(() => `${location.pathname}${location.search}`);
  navigate(loginHref(target), { replace: true });
  return null;
}

/**
 * The admin pages themselves, rendered only once the session check has passed.
 *
 * Its one job beyond passing children through is publishing the effect manifest, and the reason
 * that job lives *here* is worth reading before moving it.
 *
 * `POST /api/effects/sync` tells the backend which effects this build can draw, and it is the
 * frontend that is the authority on that, because the effect code lives here. Until Phase 2 the
 * call was made at module scope in `src/index.tsx` — meaning on every page load of every page,
 * including `/e/:slug` inside OBS. That endpoint now requires a session. Left where it was, every
 * OBS browser source would fire a request that comes back 401, on every load, forever, and log it.
 *
 * Publishing from here instead means it happens after the session check, from the admin only, and
 * never from a live browser source. `publishManifest()` remembers its own result, so navigating
 * between admin pages does not re-send it, and it never rejects — a backend that is down must not
 * stop the admin from opening and saying so.
 */
function SignedInArea(props: { children?: JSX.Element }): JSX.Element {
  onSettled(() => {
    void publishManifest();
  });
  return <>{props.children}</>;
}
