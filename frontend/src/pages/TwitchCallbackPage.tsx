import { createMemo, Errored, Loading, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useSearchParams } from "@solidjs/router";
import { completeTwitchOAuth, describeError } from "~/api/client";
import type { TwitchView } from "~/types/contract";
import { Banner } from "~/components/Banner";

/**
 * `/admin/twitch/callback` — where Twitch sends the browser back after "Connect with Twitch".
 *
 * ## How the whole flow fits together
 *
 * The Settings page sends the operator to `id.twitch.tv/oauth2/authorize`, naming this URL as the
 * `redirect_uri`. When the operator approves, Twitch redirects here with `?code=...` appended —
 * a single-use authorization code, not a token. The code is worthless on its own: only a request
 * that also presents the application's client secret can exchange it for tokens, and the secret
 * lives on the backend. So this page's one job is to hand the code to
 * `POST /api/settings/twitch/oauth/complete` and report what happened.
 *
 * The `redirectUri` sent with the exchange must be byte-identical to the one the authorize step
 * used, because Twitch compares the two before honouring it — that check is what stops a stolen
 * code from being redeemed through a different application. Both sides of this codebase derive it
 * the same way, from `location.origin`, so they cannot drift apart.
 *
 * ## Why this page lives inside the admin shell
 *
 * The completion endpoint is protected, and only a signed-in operator can have started the flow —
 * the "Connect with Twitch" button is on a protected page. Being under `/admin` means the shell's
 * session gate runs first, so an expired session shows the ordinary login redirect instead of a
 * bare 401 error.
 */
export default function TwitchCallbackPage(): JSX.Element {
  /*
   * The query parameters are read once, `untrack`ed: this page acts on the URL it was opened with,
   * and nothing here re-runs on a URL change — the same "this read is on purpose" situation as
   * `RedirectToLogin` in `AdminShell.tsx`.
   *
   * On approval Twitch sends `?code=`. On refusal it sends `?error=` and `?error_description=`
   * instead (for example `access_denied` when the operator clicks Cancel), so both shapes must
   * render something sensible.
   */
  const [searchParams] = useSearchParams<{
    code?: string;
    error?: string;
    error_description?: string;
  }>();
  const code = untrack(() => searchParams.code);
  const refusal = untrack(() => searchParams.error);
  const refusalDetail = untrack(() => searchParams.error_description);

  /*
   * The exchange, started as the page opens. An async memo whose body reads only the constants
   * above, so it runs exactly once — which matters more than usual here, because the code is
   * single-use: a second POST with the same code would fail at Twitch even though the first one
   * succeeded.
   */
  const exchanged = createMemo(async (): Promise<TwitchView | null> => {
    if (!code) return null;
    return completeTwitchOAuth({
      code,
      redirectUri: `${location.origin}/admin/twitch/callback`,
    });
  });

  return (
    <>
      <div class="page-head">
        <div>
          <h1>Twitch authorization</h1>
          <p>Finishing the sign-in that started on the Settings page.</p>
        </div>
      </div>

      <section class="card">
        <Show
          when={!refusal}
          fallback={
            <>
              <Banner
                kind="error"
                message={`Twitch did not authorize the connection (${refusal ?? ""}${
                  refusalDetail ? `: ${refusalDetail}` : ""
                }).`}
              />
              <p class="muted">
                Nothing was changed. Chat keeps working anonymously — signing in is optional.
              </p>
            </>
          }
        >
          <Show
            when={code}
            fallback={
              <p class="muted">
                This page expects to be opened by Twitch's redirect, with a <code>?code=</code> in
                the address — opened directly, there is nothing for it to do. Start from the
                "Connect with Twitch" button on the Settings page.
              </p>
            }
          >
            <Errored
              fallback={(error: unknown) => (
                <>
                  <Banner kind="error" message={describeError(error)} />
                  <p class="muted">
                    The code Twitch sent could not be exchanged for tokens. Codes are single-use and
                    expire within minutes, so reloading this page cannot help — go back to Settings
                    and start the flow again.
                  </p>
                </>
              )}
            >
              <Loading fallback={<p class="muted">Exchanging the code with Twitch…</p>}>
                <Show when={exchanged()} keyed>
                  {(view: TwitchView) => (
                    <>
                      <Banner
                        kind="ok"
                        message={
                          view.settings.botLogin
                            ? `Connected as ${view.settings.botLogin}. The server stored the tokens and is reconnecting to chat.`
                            : "Connected. The server stored the tokens and is reconnecting to chat."
                        }
                      />
                      <p class="muted">
                        The tokens never appeared in this browser — Twitch handed this page a
                        single-use code, and the server exchanged it directly.
                      </p>
                    </>
                  )}
                </Show>
              </Loading>
            </Errored>
          </Show>
        </Show>

        <div class="btn-row">
          <a class="btn btn-primary" href="/admin/settings">
            Back to Settings
          </a>
        </div>
      </section>
    </>
  );
}
