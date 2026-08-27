import { createMemo, createSignal, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { ApiError, describeError, login } from "~/api/client";
import { loadSession, rememberSession, safeNextPath, type SessionState } from "~/auth/session";
import { Banner } from "~/components/Banner";

/**
 * `/admin/login` — the sign-in form.
 *
 * ## Why this page is not inside `AdminShell`
 *
 * The shell is the thing that checks the session and sends anyone without one here. If the login
 * form lived inside it, the check would have to carve out an exception for its own login path —
 * and an exception inside a guard is how a guard eventually stops guarding. Keeping the form on a
 * route of its own means the shell's rule stays "no session, no admin page", with nothing to
 * except.
 *
 * It also gives the page its own, calmer chrome: no navigation links to pages you cannot open yet,
 * and no backend health readout competing for attention with the one field you came here to fill
 * in.
 */
export default function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams<{ next?: string }>();

  const [password, setPassword] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** Seconds the backend told us to wait after too many failed attempts, or `null`. */
  const [lockedFor, setLockedFor] = createSignal<number | null>(null);

  /**
   * Where to go after a successful sign-in.
   *
   * `?next=` comes out of the URL, which means anybody can put anything in it, so it is run
   * through `safeNextPath` rather than handed to `navigate` as-is. See that function for what it
   * refuses and why.
   */
  const destination = createMemo(() => safeNextPath(searchParams.next));

  /*
   * Ask the backend about the session as the page opens.
   *
   * Two situations this handles, both of which are otherwise annoying:
   *
   *  - The operator is *already* signed in and reached this page by typing the URL or pressing
   *    "back". Showing them a password box would be a small lie; send them on instead.
   *  - The backend was started with ADMIN_AUTH_DISABLED=true, so there is no password at all. A
   *    form nobody can fill in correctly is worse than no form.
   *
   * `loadSession()` caches, so this costs no extra request when the admin shell has already asked.
   * It never rejects — an unreachable backend answers "unknown", and we then simply show the form,
   * which is the honest thing to do when we cannot tell.
   */
  const initial = createMemo(() => loadSession());

  const canSubmit = () => password() !== "" && !submitting();

  const submit = async (event: Event) => {
    event.preventDefault();
    setError(null);
    setLockedFor(null);

    const secret = password();
    if (secret === "") {
      setError("Enter the admin password.");
      return;
    }

    setSubmitting(true);
    try {
      const info = await login(secret);
      // Remember the answer we were just given rather than asking again: `POST /api/auth/login`
      // returns exactly the same `SessionInfo` shape `GET /api/auth/session` does, on purpose.
      rememberSession(info);
      // Clear the field before navigating, so the password is not left sitting in a signal that
      // outlives the form.
      setPassword("");
      navigate(destination(), { replace: true });
    } catch (e) {
      applyError(e);
    } finally {
      setSubmitting(false);
    }
  };

  /** Turns the three failures this form can produce into a message worth reading. */
  const applyError = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === "TOO_MANY_ATTEMPTS" || e.status === 429) {
        const seconds = e.retryAfterSeconds;
        setLockedFor(seconds);
        setError(
          seconds === null
            ? "Too many failed attempts. Wait a moment and try again."
            : `Too many failed attempts. The backend will refuse further tries for ${seconds} seconds.`,
        );
        return;
      }
      if (e.isUnauthorized) {
        // Deliberately the same wording the backend uses. A 401 here carries no `details` at all —
        // it must not reveal whether a password is configured or whether one recently expired.
        setError("Incorrect password.");
        return;
      }
    }
    setError(describeError(e));
  };

  return (
    <div class="login-page">
      <div class="login-card">
        <div class="login-brand">
          <span class="brand-dot" aria-hidden="true" />
          OBS Effects
        </div>

        <h1>Sign in</h1>
        <p class="muted login-intro">
          The admin panel decides what your live browser sources display, so it is behind a
          password. Your OBS sources are not: <code>/e/&lt;slug&gt;</code> keeps working whether or
          not anybody is signed in here.
        </p>

        <Banner kind="error" message={error()} />

        {/*
          The boundary covers only the "are we already signed in?" check. While it is in flight the
          form is hidden, because rendering a password box and then navigating away from it half a
          second later is a flicker the operator would try to type into.
        */}
        <Loading fallback={<p class="muted">Checking…</p>}>
          <Show when={!isAlreadyIn(initial())} fallback={<AlreadySignedIn />}>
            <form onSubmit={(e) => void submit(e)}>
              <div class="field">
                <label class="field-label" for="admin-password">
                  Admin password
                </label>
                <input
                  id="admin-password"
                  type="password"
                  /*
                   * `autocomplete="current-password"` is what tells a password manager that this
                   * is a sign-in field rather than a "choose a new password" one, so it offers the
                   * saved entry instead of generating a fresh one.
                   */
                  autocomplete="current-password"
                  spellcheck={false}
                  autofocus
                  value={password()}
                  disabled={submitting()}
                  onInput={(e) => {
                    setPassword(e.currentTarget.value);
                    setError(null);
                  }}
                />
                <p class="field-help">
                  This is the password whose bcrypt hash the backend was started with, in
                  <code> ADMIN_PASSWORD_HASH</code>. It is not stored anywhere in the browser: a
                  successful sign-in leaves only a cookie that JavaScript cannot read.
                </p>
              </div>

              <div class="btn-row">
                <button type="submit" class="btn btn-primary" disabled={!canSubmit()}>
                  {submitting() ? "Signing in…" : "Sign in"}
                </button>
                <Show when={lockedFor()}>
                  {(seconds) => <span class="faint">try again in {seconds()}s</span>}
                </Show>
              </div>
            </form>
          </Show>
        </Loading>

        <p class="login-foot faint">
          Signed out unexpectedly? A session lasts seven days and also ends when the backend
          restarts — there is no session database, on purpose.
        </p>
      </div>
    </div>
  );
}

/**
 * Shown instead of the form when there is nothing to sign in to, and moves the operator on.
 *
 * The navigation happens while the component is being set up — Solid Router used to ship a
 * `<Navigate href="…" />` component for exactly this and no longer does, and calling
 * `useNavigate()` during setup is the documented replacement. The destination is re-derived from
 * the URL here rather than passed in as a prop, so this component reads nothing reactive from its
 * caller and the redirect cannot be triggered by a later, unrelated re-render.
 *
 * The sentence is still worth rendering: a redirect is not instant, and a blank panel for a
 * fraction of a second reads as a broken page.
 */
function AlreadySignedIn(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams<{ next?: string }>();
  navigate(safeNextPath(searchParams.next), { replace: true });
  return <p class="muted">Already signed in — taking you back…</p>;
}

/**
 * True when there is nothing to sign in to: either we already are, or the backend was started with
 * authentication switched off entirely.
 *
 * Written against the value rather than the signal so the same test can be applied to the freshly
 * loaded answer and to the shared one in `sessionState()`.
 */
function isAlreadyIn(info: SessionState): boolean {
  return info !== null && info !== undefined && (info.authenticated || !info.authRequired);
}
