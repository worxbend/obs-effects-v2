import {
  createMemo,
  createSignal,
  Errored,
  For,
  Loading,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  ApiError,
  audioLevelsUrl,
  chatWsUrl,
  deleteSound,
  describeError,
  getObsAudioSettings,
  getSoundboard,
  getTwitchAdminStatus,
  getTwitchSettings,
  listSounds,
  soundAudioUrl,
  updateSoundboard,
  submitTwitchTokens,
  updateObsAudioSettings,
  updateTwitchSettings,
  uploadSound,
} from "~/api/client";
import type {
  AudioLevels,
  ChatMessage,
  ChatPart,
  ChatWsFrame,
  ObsAudioSettingsRequest,
  ObsAudioView,
  ObsConnectionState,
  SoundInfo,
  Soundboard,
  SoundboardCondition,
  SoundboardEventValue,
  SoundboardGroupCondition,
  SoundboardLeafCondition,
  SoundboardLeafType,
  SoundboardRuleWrite,
  TwitchAdminStatus,
  TwitchConnectionState,
  TwitchConnectionStatus,
  TwitchSettingsRequest,
  TwitchView,
  ValidationIssue,
} from "~/types/contract";
import { newTwitchOauthState, rememberTwitchOauthState, twitchRedirectUri } from "~/auth/twitchOauth";
import { compileSoundboard, matchRule } from "~/effects/sdk/soundboard";
import { Banner } from "~/components/Banner";

/**
 * `/admin/settings` — where the OBS WebSocket connection is configured.
 *
 * ## What this page is for
 *
 * Audio-reactive effects react to the audio **OBS is broadcasting**. To read that, the backend keeps
 * a connection open to OBS's own `obs-websocket` server, and this form is where an operator says
 * where that server is and what its password is.
 *
 * ## Why the connection is made by the backend and not by the browser
 *
 * The overlay pages at `/e/<slug>` are deliberately unauthenticated — an OBS browser source cannot
 * sign in. If those pages opened the WebSocket themselves, the obs-websocket password would have to
 * be served from a public endpoint to anybody who asked for it. With the backend as the client the
 * password never leaves the server, one connection serves every browser source, and this page can
 * show a connection status that means something.
 *
 * ## The live meter at the bottom
 *
 * The single most useful thing this page does is prove the connection works. A form that says
 * "saved" tells you nothing about whether OBS is actually being heard, so the page subscribes to the
 * same public levels stream the overlays read and draws it. If that bar moves when you talk, the
 * whole feature works — no need to open OBS, add a browser source and squint at an overlay.
 */
export default function SettingsPage(): JSX.Element {
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <p>
            How this server talks to OBS and to Twitch. Audio-reactive effects follow the audio OBS
            is broadcasting, which it reads over the OBS WebSocket server rather than from a
            microphone; chat-reactive effects follow the Twitch chat of the channel configured
            below.
          </p>
        </div>
      </div>

      <ObsAudioCard />
      <LevelMeterCard />
      <TwitchCard />
      <ChatPreviewCard />
      <SoundsCard />
      <SoundboardCard />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The settings form                                                   */
/* ------------------------------------------------------------------ */

function ObsAudioCard(): JSX.Element {
  /** Bumped after every save so the loader below re-reads settings *and* the fresh status. */
  const [reloadToken, setReloadToken] = createSignal(0);

  const loaded = createMemo(async (): Promise<ObsAudioView> => {
    reloadToken();
    return getObsAudioSettings();
  });

  return (
    <section class="card">
      <div class="card-title">
        <h2>OBS WebSocket</h2>
      </div>
      <Errored
        fallback={(error: unknown) => <Banner kind="error" message={describeError(error)} />}
      >
        <Loading fallback={<p class="muted">Loading settings…</p>}>
          <Show when={loaded()} keyed>
            {(view: ObsAudioView) => (
              <ObsAudioForm view={view} onSaved={() => setReloadToken((n) => n + 1)} />
            )}
          </Show>
        </Loading>
      </Errored>
    </section>
  );
}

function ObsAudioForm(props: { view: ObsAudioView; onSaved: () => void }): JSX.Element {
  /*
   * The form is *seeded* from the loaded settings and then owned by the operator's typing, so these
   * three reads are deliberately one-time rather than reactive — re-seeding a field while somebody
   * is typing in it would throw their edit away.
   *
   * That is safe because of the `keyed` on the `<Show>` that renders this component: a new view
   * replaces the whole component rather than updating it in place, so "seed once at mount" and
   * "follow the latest data" are the same thing here.
   *
   * `untrack` is Solid's own way of saying "this read is on purpose". Without it the linter is
   * right to complain, because the pattern it is warning about — reading a prop once and silently
   * ignoring every later change — is exactly what this looks like from the outside.
   */
  const initial = untrack(() => props.view.settings);

  const [enabled, setEnabled] = createSignal(initial.enabled);
  const [url, setUrl] = createSignal(initial.url);
  const [inputName, setInputName] = createSignal(initial.inputName ?? "");

  /**
   * The password box, and the three-state rule it implements.
   *
   * `null` means "not touched" — the box shows a placeholder saying a password is stored, and the
   * save omits the field so the server keeps what it has. The moment the operator types anything the
   * value becomes a string and the save sends it. "Clear" sets it to the empty string, which the
   * save sends as `null`, meaning remove.
   *
   * Without the untouched state, editing the URL alone would wipe the stored password, because the
   * form has no way to send back a value it was never given.
   */
  const [password, setPassword] = createSignal<string | null>(null);

  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);

  const status = () => props.view.status;

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    const typed = password();
    const body: ObsAudioSettingsRequest = {
      enabled: enabled(),
      url: url().trim(),
      inputName: inputName().trim() === "" ? null : inputName().trim(),
      // Omitted entirely when untouched; `null` when cleared; the string otherwise.
      ...(typed === null ? {} : { password: typed === "" ? null : typed }),
    };

    try {
      await updateObsAudioSettings(body);
      setPassword(null);
      setSaved(true);
      props.onSaved();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <ConnectionBadge view={props.view} />

      <div class="field">
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={enabled()}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />
          <span>Connect to OBS</span>
        </label>
        <p class="field-help">
          Leave this off and audio-reactive effects show a simulated signal instead. Nothing else
          changes — no effect fails, and no overlay goes blank.
        </p>
      </div>

      <div class="field">
        <label class="field-label" for="obs-url">
          WebSocket URL
        </label>
        <input
          id="obs-url"
          type="text"
          value={url()}
          spellcheck={false}
          onInput={(event) => setUrl(event.currentTarget.value)}
          placeholder="ws://host.docker.internal:4455"
        />
        <p class="field-help">
          In OBS: <strong>Tools → WebSocket Server Settings</strong>. The port there is the one to
          use; 4455 is the default. The host is almost never <code>localhost</code>: this backend
          runs inside a container, where <code>localhost</code> means the container itself, so the
          machine running OBS is <code>host.docker.internal</code>.
        </p>
      </div>

      <div class="field">
        <label class="field-label" for="obs-password">
          Password
        </label>
        <input
          id="obs-password"
          type="password"
          value={password() ?? ""}
          autocomplete="off"
          onInput={(event) => setPassword(event.currentTarget.value)}
          placeholder={
            props.view.settings.passwordSet
              ? "A password is saved — type to replace it"
              : "No password saved"
          }
        />
        <p class="field-help">
          From the same OBS dialog, under <strong>Show Connect Info</strong>. It is stored so the
          server can present it to OBS, which means it cannot be hashed — so it is never sent back
          to this page, and never reaches an overlay.{" "}
          <Show when={props.view.settings.passwordSet}>
            <button type="button" class="btn btn-sm" onClick={() => setPassword("")}>
              Clear the saved password
            </button>
          </Show>
        </p>
      </div>

      <div class="field">
        <label class="field-label" for="obs-input">
          Audio input
        </label>
        <Show
          when={status().inputs.length > 0}
          fallback={
            <input
              id="obs-input"
              type="text"
              value={inputName()}
              onInput={(event) => setInputName(event.currentTarget.value)}
              placeholder="All inputs"
            />
          }
        >
          <select
            id="obs-input"
            value={inputName()}
            onChange={(event) => setInputName(event.currentTarget.value)}
          >
            <option value="">All inputs (summed)</option>
            <For each={status().inputs}>{(name) => <option value={name}>{name}</option>}</For>
          </select>
        </Show>
        <p class="field-help">
          Which OBS audio source to follow. "All inputs" takes the loudest of everything, which is
          usually what you want. The dropdown lists the inputs OBS has actually reported since
          connecting — if it is a plain text box instead, nothing has connected yet, and the name
          must match OBS exactly.
        </p>
      </div>

      <div class="btn-row">
        <button type="submit" class="btn btn-primary" disabled={saving()}>
          {saving() ? "Saving…" : "Save and reconnect"}
        </button>
        <Show when={saved()}>
          <span class="muted">Saved. Reconnecting…</span>
        </Show>
      </div>
      <p class="field-help">
        Saving always reconnects, even if nothing changed — this is also the "try again now" button
        for a connection that is failing.
      </p>

      <Banner kind="error" message={error()} />
    </form>
  );
}

/** The coloured state line: what the connection is doing, and why it is not doing better. */
function ConnectionBadge(props: { view: ObsAudioView }): JSX.Element {
  const status = () => props.view.status;

  const label = (): string => {
    const state: ObsConnectionState = status().state;
    switch (state) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting…";
      case "failed":
        return "Not connected";
      default:
        return "Switched off";
    }
  };

  const uptime = (): string | null => {
    const since = status().connectedSince;
    if (since === null) return null;
    const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  return (
    <div class={`obs-status obs-status-${status().state}`}>
      <strong>{label()}</strong>
      <Show when={status().obsVersion}>{(version) => <span> · OBS {version()}</span>}</Show>
      <Show when={uptime()}>{(value) => <span> · up {value()}</span>}</Show>
      <Show when={status().state === "connected"}>
        <span> · {status().levelsReceived.toLocaleString()} measurements</span>
      </Show>
      <Show when={status().subscribers > 0}>
        <span>
          {" "}
          · {status().subscribers} browser source{status().subscribers === 1 ? "" : "s"} listening
        </span>
      </Show>
      <Show when={status().lastError}>
        {(message) => <p class="obs-status-error">{message()}</p>}
      </Show>
      <Show when={status().state === "connected" && status().levelsReceived === 0}>
        <p class="obs-status-error">
          Connected, but OBS has not sent a single volume measurement. That usually means every
          audio source in the current scene collection is muted or inactive.
        </p>
      </Show>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The live meter                                                      */
/* ------------------------------------------------------------------ */

/**
 * Draws the same stream the overlays read, so this page can prove the connection end to end.
 *
 * It subscribes directly rather than going through the effect SDK's audio bus on purpose: the bus
 * smooths, interpolates and falls back to a simulated signal, all of which are exactly right for an
 * overlay and exactly wrong for a diagnostic. Here a flat bar has to mean "no audio", not "a
 * plausible substitute for audio".
 */
function LevelMeterCard(): JSX.Element {
  const [levels, setLevels] = createSignal<AudioLevels | null>(null);
  const [stale, setStale] = createSignal(true);

  const stream = new EventSource(audioLevelsUrl());
  stream.addEventListener("levels", (event: MessageEvent<string>) => {
    try {
      setLevels(JSON.parse(event.data) as AudioLevels);
      setStale(false);
    } catch {
      // A malformed frame is not worth reporting: the next one is 50 milliseconds away.
    }
  });

  // If nothing arrives for a while the bar should fall to zero rather than freeze at the last value
  // it happened to see. A frozen meter reads as "loud and stuck", which is the wrong answer.
  const timer = setInterval(() => {
    const last = levels();
    if (last === null || Date.now() - last.at > 6000) setStale(true);
  }, 1000);

  onCleanup(() => {
    stream.close();
    clearInterval(timer);
  });

  const peak = (): number => (stale() ? 0 : (levels()?.peak ?? 0));

  return (
    <section class="card">
      <div class="card-title">
        <h2>Live level</h2>
      </div>
      <p>
        This is the stream every audio-reactive overlay reads. If the bar moves when sound plays in
        OBS, the whole path works.
      </p>

      <div class="meter" role="img" aria-label={`Audio peak ${Math.round(peak() * 100)} percent`}>
        <div class="meter-fill" style={{ width: `${Math.round(peak() * 100)}%` }} />
      </div>

      <Show
        when={!stale()}
        fallback={
          <p class="muted">
            No measurements are arriving. Either the connection above is not up, or OBS has nothing
            playing. Overlays are showing a simulated signal.
          </p>
        }
      >
        <ul class="input-levels">
          <For each={levels()?.inputs ?? []}>
            {(input) => (
              <li>
                <span class="input-name">{input.inputName}</span>
                <span class="input-peak">{Math.round(input.peak * 100)}%</span>
              </li>
            )}
          </For>
        </ul>
        <Show when={(levels()?.inputs.length ?? 0) === 0}>
          <p class="muted">Connected and silent — no input is producing sound right now.</p>
        </Show>
      </Show>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Twitch chat settings                                                */
/* ------------------------------------------------------------------ */

/**
 * The Twitch chat connection: which channel to read, and how to authenticate.
 *
 * Same architecture as the OBS card above, and for the same reasons: the *backend* connects to
 * Twitch, so tokens never reach a browser, history is recorded with no page open, and one upstream
 * connection serves every browser source. This card only edits the settings that connection uses.
 *
 * Authentication is entirely optional. Twitch allows anonymous read-only chat connections, so a
 * channel name alone is enough for chat overlays to work — the credentials below only make the
 * connection identified, which is what token refresh and any future authenticated features need.
 */
function TwitchCard(): JSX.Element {
  /** Bumped after every save so the loader below re-reads settings *and* the fresh status. */
  const [reloadToken, setReloadToken] = createSignal(0);

  const loaded = createMemo(async (): Promise<TwitchView> => {
    reloadToken();
    return getTwitchSettings();
  });

  return (
    <section class="card">
      <div class="card-title">
        <h2>Twitch chat</h2>
      </div>
      <Errored
        fallback={(error: unknown) => <Banner kind="error" message={describeError(error)} />}
      >
        <Loading fallback={<p class="muted">Loading settings…</p>}>
          <Show when={loaded()} keyed>
            {(view: TwitchView) => (
              <>
                <TwitchForm view={view} onSaved={() => setReloadToken((n) => n + 1)} />
                <TwitchAuthPanel view={view} onChanged={() => setReloadToken((n) => n + 1)} />
              </>
            )}
          </Show>
        </Loading>
      </Errored>
    </section>
  );
}

function TwitchForm(props: { view: TwitchView; onSaved: () => void }): JSX.Element {
  // Seeded once, owned by the operator's typing afterwards — same pattern and same `keyed`
  // justification as `ObsAudioForm` above.
  const initial = untrack(() => props.view.settings);

  const [enabled, setEnabled] = createSignal(initial.enabled);
  const [channel, setChannel] = createSignal(initial.channel);
  const [clientId, setClientId] = createSignal(initial.clientId);

  /**
   * The client secret box, with the same three-state rule as the OBS password above: `null` means
   * "not touched" (the save omits the field, the server keeps what it has), a string means
   * "replace", and the empty string is sent as `null`, meaning "remove".
   */
  const [clientSecret, setClientSecret] = createSignal<string | null>(null);

  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    const typed = clientSecret();
    const body: TwitchSettingsRequest = {
      enabled: enabled(),
      // Twitch logins are lowercase; folding here means a pasted "WorxBend" still matches.
      channel: channel().trim().toLowerCase(),
      clientId: clientId().trim(),
      // Omitted entirely when untouched; `null` when cleared; the string otherwise.
      ...(typed === null ? {} : { clientSecret: typed === "" ? null : typed }),
    };

    try {
      await updateTwitchSettings(body);
      setClientSecret(null);
      setSaved(true);
      props.onSaved();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <TwitchStatusBadge status={props.view.status} />

      <div class="field">
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={enabled()}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />
          <span>Connect to Twitch chat</span>
        </label>
        <p class="field-help">
          Leave this off and chat-reactive effects show a gentle simulated feed instead. Nothing
          else changes — no effect fails, and no overlay goes blank.
        </p>
      </div>

      <div class="field">
        <label class="field-label" for="twitch-channel">
          Channel
        </label>
        <input
          id="twitch-channel"
          type="text"
          value={channel()}
          spellcheck={false}
          onInput={(event) => setChannel(event.currentTarget.value)}
          placeholder="worxbend"
        />
        <p class="field-help">
          The channel whose chat the overlays should follow — the name from{" "}
          <code>twitch.tv/&lt;name&gt;</code>. A channel alone is enough: Twitch allows anonymous
          read-only chat connections, so nothing below is required for chat to flow.
        </p>
      </div>

      <div class="field">
        <label class="field-label" for="twitch-client-id">
          Client ID
        </label>
        <input
          id="twitch-client-id"
          type="text"
          value={clientId()}
          spellcheck={false}
          onInput={(event) => setClientId(event.currentTarget.value)}
          placeholder="Optional — only needed to sign the connection in"
        />
        <p class="field-help">
          From a Twitch application registered at <code>dev.twitch.tv/console</code>, with{" "}
          <code>{oauthRedirectUri()}</code> as an OAuth redirect URL. The client ID is not a secret
          — it appears in every OAuth URL by design.
        </p>
      </div>

      <div class="field">
        <label class="field-label" for="twitch-client-secret">
          Client secret
        </label>
        <input
          id="twitch-client-secret"
          type="password"
          value={clientSecret() ?? ""}
          autocomplete="off"
          onInput={(event) => setClientSecret(event.currentTarget.value)}
          placeholder={
            props.view.settings.clientSecretSet
              ? "A secret is saved — type to replace it"
              : "No secret saved"
          }
        />
        <p class="field-help">
          From the same Twitch application page. It is stored so the server can exchange and refresh
          OAuth tokens, which means it cannot be hashed — so it is never sent back to this page, and
          never reaches an overlay.{" "}
          <Show when={props.view.settings.clientSecretSet}>
            <button type="button" class="btn btn-sm" onClick={() => setClientSecret("")}>
              Clear the saved secret
            </button>
          </Show>
        </p>
      </div>

      <div class="btn-row">
        <button type="submit" class="btn btn-primary" disabled={saving()}>
          {saving() ? "Saving…" : "Save and reconnect"}
        </button>
        <Show when={saved()}>
          <span class="muted">Saved. Reconnecting…</span>
        </Show>
      </div>
      <p class="field-help">
        Saving always reconnects, even if nothing changed — this is also the "try again now" button
        for a connection that is failing.
      </p>

      <Banner kind="error" message={error()} />
    </form>
  );
}

/** The coloured state line for the Twitch connection, mirroring `ConnectionBadge` above. */
function TwitchStatusBadge(props: { status: TwitchConnectionStatus }): JSX.Element {
  const label = (): string => {
    const state: TwitchConnectionState = props.status.state;
    switch (state) {
      case "connected_authed":
        return "Connected (signed in)";
      case "connected_anonymous":
        return "Connected (anonymous, read-only)";
      case "connecting":
        return "Connecting…";
      case "failed":
        return "Not connected";
      default:
        return "Switched off";
    }
  };

  /*
   * The CSS knows four visual states (`.obs-status-*`), shared with the OBS badge above. The two
   * "connected" flavours map to the same green — the words carry the distinction; the colour only
   * has to answer "is it working?".
   */
  const tone = (): string => {
    switch (props.status.state) {
      case "connected_authed":
      case "connected_anonymous":
        return "connected";
      case "connecting":
        return "connecting";
      case "failed":
        return "failed";
      default:
        return "disabled";
    }
  };

  return (
    <div class={["obs-status", `obs-status-${tone()}`]}>
      <strong>{label()}</strong>
      <Show when={props.status.channel}>{(name) => <span> · #{name()}</span>}</Show>
      <Show when={props.status.state.startsWith("connected")}>
        <span> · {props.status.messagesReceived.toLocaleString()} messages</span>
      </Show>
      <Show when={props.status.lastError}>
        {(message) => <p class="obs-status-error">{message()}</p>}
      </Show>
    </div>
  );
}

/**
 * The redirect URI both halves of the OAuth flow must agree on, byte for byte. It lives in
 * `auth/twitchOauth.ts` alongside the flow's other shared piece, the one-time `state` value.
 */
const oauthRedirectUri = twitchRedirectUri;

/**
 * The permissions the "Connect with Twitch" button asks for, space-separated as Twitch wants them.
 *
 * A "scope" is one permission the operator grants while approving the app. `chat:read` is all the
 * chat overlays have ever needed; the three moderation scopes are what the Twitch dashboard at
 * `/admin/twitch` uses to read the ban list and to ban, time out and unban accounts.
 *
 * Asking for all four here, rather than only when somebody first opens the dashboard, is what
 * keeps the flow to a single approval screen. A token granted before this list grew simply lacks
 * the moderation scopes: chat keeps working exactly as it did, and reconnecting is what upgrades
 * it. Nothing about chat is ever blocked on a moderation permission.
 */
const TWITCH_OAUTH_SCOPES =
  "chat:read moderator:read:banned_users moderator:manage:banned_users moderation:read";

/**
 * What the stored token is actually allowed to do.
 *
 * The permissions live on the token, not in these settings, so the only honest source for them is
 * the server that holds it: `GET /api/twitch/admin/status` reports the granted scopes and which
 * required ones are missing, and it always answers 200 — "nothing is connected" is one of its
 * normal answers rather than an error. The `.catch(() => null)` keeps a backend that is down from
 * turning this footnote into a failure on a page whose main job is unrelated.
 */
function TwitchScopesNote(): JSX.Element {
  const status = createMemo(() => getTwitchAdminStatus().catch(() => null));

  return (
    <Loading fallback={null}>
      {/* `keyed` unwraps the settled value; a `null` from the catch above is falsy, so a backend
          that could not answer draws nothing at all rather than an empty permissions list. */}
      <Show when={status()} keyed>
        {(info: TwitchAdminStatus) => (
          <Show when={info.grantedScopes.length > 0}>
            <div class="field">
              <span class="field-label">Permissions this token carries</span>
              <div class="tag-row">
                <For each={info.grantedScopes}>{(scope) => <span class="tag">{scope}</span>}</For>
              </div>
              <Show when={info.missingScopes.length > 0}>
                <p class="field-help">
                  Missing for moderation: {info.missingScopes.join(", ")}. Press “Connect with
                  Twitch” again to grant them — the sign-in now asks for the moderation permissions
                  as well, and the <a href="/admin/twitch">Twitch dashboard</a> needs them. Chat is
                  unaffected either way.
                </p>
              </Show>
            </div>
          </Show>
        )}
      </Show>
    </Loading>
  );
}

/**
 * The two ways to sign the chat connection in, both optional.
 *
 * This is a sibling of `TwitchForm` rather than part of it, because the manual token entry is a
 * `<form>` of its own and HTML forbids nesting one form inside another — the browser silently
 * drops the inner form element, and its submit button would then submit the outer form instead.
 */
function TwitchAuthPanel(props: { view: TwitchView; onChanged: () => void }): JSX.Element {
  const [accessToken, setAccessToken] = createSignal("");
  const [refreshToken, setRefreshToken] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  /*
   * The OAuth flow needs both stored credentials: the redirect sends back a single-use *code*, and
   * only the backend — holding the client secret — can exchange it for tokens. The button is
   * rendered disabled rather than hidden when they are missing, because a control that explains
   * what it is waiting for beats one that is invisibly absent.
   */
  const oauthReady = (): boolean =>
    props.view.settings.clientId.trim() !== "" && props.view.settings.clientSecretSet;

  /*
   * The one-time random `state` this panel's link carries. See `auth/twitchOauth.ts`: Twitch echoes
   * it back to the callback page, which refuses to exchange a code that did not come with the value
   * this browser sent. That is what stops somebody from mailing the operator a link to the callback
   * with an authorization code for *their* Twitch account in it.
   *
   * It is made once per panel so the address the link points at is stable, and written to storage
   * on the click — see the anchor below — so that leaving for Twitch a second time from the same
   * page still has a value waiting on the way back.
   */
  const oauthState = newTwitchOauthState();

  const oauthHref = (): string => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: props.view.settings.clientId.trim(),
      redirect_uri: oauthRedirectUri(),
      scope: TWITCH_OAUTH_SCOPES,
      state: oauthState,
    });
    return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  };

  async function submitTokens(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await submitTwitchTokens({
        accessToken: accessToken().trim(),
        refreshToken: refreshToken().trim() === "" ? null : refreshToken().trim(),
      });
      setAccessToken("");
      setRefreshToken("");
      props.onChanged();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div class="field">
        <span class="field-label">Sign the connection in (optional)</span>
        <p class="field-help">
          <Show
            when={props.view.settings.tokensSet}
            fallback={<>No account is connected — chat is read anonymously.</>}
          >
            An account is connected
            <Show when={props.view.settings.botLogin}>{(login) => <> as {login()}</>}</Show>.
            Connecting again replaces the stored tokens.
          </Show>
        </p>
        <div class="btn-row">
          <Show
            when={oauthReady()}
            fallback={
              <button type="button" class="btn" disabled>
                Connect with Twitch
              </button>
            }
          >
            <a
              class="btn btn-primary"
              href={oauthHref()}
              onClick={() => rememberTwitchOauthState(oauthState)}
            >
              Connect with Twitch
            </a>
          </Show>
        </div>
        <Show when={props.view.settings.tokensSet}>
          <TwitchScopesNote />
        </Show>
        <Show when={!oauthReady()}>
          <p class="field-help">
            Save a client ID and client secret above first — the sign-in flow sends Twitch's answer
            to this server, and the server needs both to complete it.
          </p>
        </Show>
      </div>

      <form onSubmit={(event) => void submitTokens(event)}>
        <div class="field">
          <label class="field-label" for="twitch-access-token">
            Or paste tokens obtained elsewhere
          </label>
          <input
            id="twitch-access-token"
            type="password"
            value={accessToken()}
            autocomplete="off"
            onInput={(event) => setAccessToken(event.currentTarget.value)}
            placeholder="Access token"
          />
          <input
            id="twitch-refresh-token"
            type="password"
            value={refreshToken()}
            autocomplete="off"
            onInput={(event) => setRefreshToken(event.currentTarget.value)}
            placeholder="Refresh token (optional)"
          />
          <p class="field-help">
            For tokens from the Twitch CLI or a token generator. They go straight to the server and
            are stored there; without a refresh token the connection falls back to anonymous when
            the access token expires.
          </p>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn" disabled={submitting() || accessToken().trim() === ""}>
            {submitting() ? "Saving…" : "Save tokens"}
          </button>
        </div>
        <Banner kind="error" message={error()} />
      </form>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The live chat preview                                               */
/* ------------------------------------------------------------------ */

/** How many messages the preview keeps on screen. A diagnostic, not a chat client. */
const PREVIEW_LIMIT = 20;

/**
 * Shows the same WebSocket stream the chat overlays read, so this page can prove the connection
 * end to end — the chat equivalent of `LevelMeterCard` above.
 *
 * It opens a raw WebSocket rather than going through the effect SDK's chat bus, for the same
 * reason the meter bypasses the audio bus: the bus falls back to a simulated feed when the stream
 * is down, which is exactly right for an overlay and exactly wrong for a diagnostic. Here an empty
 * list has to mean "no chat is arriving", not "here is a plausible substitute".
 */
function ChatPreviewCard(): JSX.Element {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [connected, setConnected] = createSignal(false);
  const [status, setStatus] = createSignal<TwitchConnectionStatus | null>(null);

  /*
   * A deliberately plain reconnect: fixed three-second retry, no backoff. The SDK's exponential
   * backoff exists because dozens of unattended overlays must not hammer a dead backend; this is
   * one page, open in front of an operator who wants it back promptly.
   */
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const scheduleRetry = (): void => {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, 3000);
  };

  const connect = (): void => {
    if (stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(chatWsUrl());
    } catch {
      scheduleRetry();
      return;
    }
    socket = ws;
    ws.addEventListener("open", () => setConnected(true));
    ws.addEventListener("message", (event: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(event.data) as ChatWsFrame;
        if (frame.type === "snapshot") setMessages(frame.messages.slice(-PREVIEW_LIMIT));
        else if (frame.type === "message")
          setMessages((list) => [...list, frame.message].slice(-PREVIEW_LIMIT));
        else if (frame.type === "status") setStatus(frame.status);
      } catch {
        // A malformed frame is not worth reporting; the stream carries on without it.
      }
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
      setConnected(false);
      scheduleRetry();
    });
  };

  connect();

  onCleanup(() => {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    socket?.close();
  });

  /** A short marker for the channel events that are not ordinary chat lines. */
  const eventTag = (message: ChatMessage): string | null => {
    switch (message.event) {
      case "sub":
        return "SUB";
      case "gift_sub":
        return "GIFT";
      case "cheer":
        return "CHEER";
      case "raid":
        return "RAID";
      default:
        return null;
    }
  };

  return (
    <section class="card">
      <div class="card-title">
        <h2>Live chat</h2>
      </div>
      <p>
        This is the stream every chat-reactive overlay reads. If messages appear here when someone
        chats in the channel, the whole path works.
      </p>

      <Show when={!connected()}>
        <p class="muted">Not connected to the backend's chat stream — retrying…</p>
      </Show>
      <Show when={status()}>
        {(current) => (
          <Show when={current().state === "failed" && current().lastError}>
            {(message) => <p class="obs-status-error">{message()}</p>}
          </Show>
        )}
      </Show>

      <Show
        when={messages().length > 0}
        fallback={
          <p class="muted">
            Nothing yet. Chat history appears the moment a message arrives in the configured channel
            — overlays are showing a simulated feed until then.
          </p>
        }
      >
        <ul class="chat-preview">
          <For each={messages()}>
            {(message) => (
              <li>
                <Show when={eventTag(message)}>
                  {(tag) => <span class="chat-event">{tag()}</span>}
                </Show>
                <span class="chat-user" style={{ color: message.color }}>
                  {message.displayName}
                </span>
                <span class="chat-text">{message.text}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Chat-triggered sounds                                               */
/* ------------------------------------------------------------------ */

/**
 * The library of audio clips chat-triggered effects can play.
 *
 * Same shape as `ObsAudioCard` and `TwitchCard`: a loader keyed on a reload token, re-run after
 * every mutation so the listing never shows a sound that is already gone or misses one that was
 * only uploaded. Two builtin clips ("discord", "slack-message") always exist and cannot be
 * deleted, so effects can reference them by name as safe defaults.
 */
function SoundsCard(): JSX.Element {
  /** Bumped after every upload or delete so the loader below re-reads the listing. */
  const [reloadToken, setReloadToken] = createSignal(0);

  const loaded = createMemo(async (): Promise<SoundInfo[]> => {
    reloadToken();
    return listSounds();
  });

  return (
    <section class="card">
      <div class="card-title">
        <h2>Sounds</h2>
      </div>
      <p>
        Audio clips the chat-triggered effects can play — the Chat Sound effect picks one of these
        by name. The playback endpoint is public, like the audio and chat streams, because an OBS
        browser source cannot sign in.
      </p>
      <Errored
        fallback={(error: unknown) => <Banner kind="error" message={describeError(error)} />}
      >
        <Loading fallback={<p class="muted">Loading sounds…</p>}>
          <Show when={loaded()} keyed>
            {(sounds: SoundInfo[]) => (
              <>
                <SoundList sounds={sounds} onChanged={() => setReloadToken((n) => n + 1)} />
                <SoundUploadForm onUploaded={() => setReloadToken((n) => n + 1)} />
              </>
            )}
          </Show>
        </Loading>
      </Errored>
    </section>
  );
}

/** A human-readable size: bytes below a kilobyte, then one-decimal KB / MB. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SoundList(props: { sounds: SoundInfo[]; onChanged: () => void }): JSX.Element {
  const [error, setError] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<string | null>(null);

  async function remove(sound: SoundInfo): Promise<void> {
    setDeleting(sound.id);
    setError(null);
    try {
      await deleteSound(sound.id);
      props.onChanged();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <>
      <Show when={props.sounds.length > 0} fallback={<p class="muted">No sounds stored yet.</p>}>
        <ul class="sound-list">
          <For each={props.sounds}>
            {(sound) => (
              <li class="sound-row">
                <span class="sound-name">
                  {sound.name}
                  <Show when={sound.builtin}>
                    {/* Builtins cannot be deleted, so the badge explains the missing button. */}
                    <span class="badge"> built-in</span>
                  </Show>
                </span>
                <span class="muted"> · {formatSize(sound.sizeBytes)}</span>
                {/*
                 * `preload="none"` keeps the page from downloading every clip on load — the bytes
                 * only travel when the operator presses play on that row.
                 */}
                <audio controls preload="none" src={soundAudioUrl(sound.id)} />
                <Show when={!sound.builtin}>
                  <button
                    type="button"
                    class="btn btn-sm"
                    disabled={deleting() === sound.id}
                    onClick={() => void remove(sound)}
                  >
                    {deleting() === sound.id ? "Deleting…" : "Delete"}
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Banner kind="error" message={error()} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The soundboard                                                      */
/* ------------------------------------------------------------------ */

/**
 * The chat-triggered soundboard: an ordered list of rules, each mapping a *condition tree* over
 * incoming chat messages to a stored sound. The Soundboard effect reads the saved list (publicly,
 * so an OBS browser source can) and plays the matched clip while bursting the message's emotes.
 *
 * The editor below is a nested query builder: every rule owns a tree of And/Or groups whose rows
 * test one thing about a message (its first word, a substring, a regex, an emote, an emoji, its
 * event kind, its sender). A live test box at the bottom runs the *same* evaluator the overlay
 * effect uses (`effects/sdk/soundboard.ts`), so "match" here means "would play there".
 *
 * Same shape as the cards above: a loader keyed on a reload token, a `keyed` editor seeded once
 * from the load, re-run after every save so the form shows the server-assigned rule ids.
 */
function SoundboardCard(): JSX.Element {
  /** Bumped after every save so the loader below re-reads the stored rules. */
  const [reloadToken, setReloadToken] = createSignal(0);

  const loaded = createMemo(async (): Promise<[Soundboard, SoundInfo[]]> => {
    reloadToken();
    // The sound listing rides along so the sound picker can offer real names instead of a blind
    // text box. The two are one load because the editor needs both before it can render.
    return Promise.all([getSoundboard(), listSounds()]);
  });

  return (
    <section class="card">
      <div class="card-title">
        <h2>Soundboard</h2>
      </div>
      <p>
        Rules for the Soundboard effect: when a chat message matches a rule's conditions, the
        chosen sound plays on the overlay. Rules are checked top to bottom over enabled rules only,
        and the first match wins — order the specific ones above the broad ones.
      </p>
      <Errored
        fallback={(error: unknown) => <Banner kind="error" message={describeError(error)} />}
      >
        <Loading fallback={<p class="muted">Loading soundboard…</p>}>
          <Show when={loaded()} keyed>
            {([board, sounds]: [Soundboard, SoundInfo[]]) => (
              <SoundboardEditor
                board={board}
                sounds={sounds}
                onSaved={() => setReloadToken((n) => n + 1)}
              />
            )}
          </Show>
        </Loading>
      </Errored>
    </section>
  );
}

/* --- Condition-tree helpers, pure and local to the builder ------------------------------- */

/** The condition-tree limits the backend enforces; the UI stops at them rather than saving into
 * a guaranteed validation error. */
const MAX_GROUP_CHILDREN = 20;
const MAX_TREE_DEPTH = 5;

const SOUNDBOARD_EVENTS: SoundboardEventValue[] = ["chat", "sub", "gift_sub", "cheer", "raid"];

const LEAF_TYPES: SoundboardLeafType[] = [
  "command",
  "contains",
  "regex",
  "emote",
  "emoji",
  "event",
  "user",
];

const LEAF_TYPE_LABELS: Record<SoundboardLeafType, string> = {
  command: "Command",
  contains: "Contains text",
  regex: "Regex",
  emote: "Has emote",
  emoji: "Has emoji",
  event: "Event type",
  user: "User",
};

/** Example values, one per leaf kind. Emote and emoji say "(any …)" because for those two an
 * empty value is meaningful — it matches a message carrying *any* emote or emoji. */
const LEAF_PLACEHOLDERS: Record<SoundboardLeafType, string> = {
  command: "!drum",
  contains: "hype",
  regex: "\\bhype\\b",
  emote: "(any emote)",
  emoji: "(any emoji)",
  event: "",
  user: "worxbend",
};

function emptyLeaf(): SoundboardLeafCondition {
  return { type: "command", value: "" };
}

/** A fresh group with one blank condition — an empty group cannot be saved, so a new one starts
 * with the row the operator is about to fill in anyway. */
function emptyGroup(): SoundboardGroupCondition {
  return { type: "group", op: "and", negate: false, children: [emptyLeaf()] };
}

/**
 * The rule's root condition, normalised to a group. The wire model allows a bare leaf at the
 * root, but the builder always renders an And/Or header — and a one-child "and" group means
 * exactly the same thing as its lone child, so wrapping changes nothing the matcher can see.
 */
function asGroup(condition: SoundboardCondition | undefined): SoundboardGroupCondition {
  if (condition === undefined) return emptyGroup();
  if (condition.type === "group") return condition;
  return { type: "group", op: "and", negate: false, children: [condition] };
}

/**
 * Returns a new tree with the node at `path` (child indexes from the root) replaced by `fn`'s
 * result; `null` from `fn` removes the node. Everything on the way is copied, nothing is
 * mutated — the signal holding the root sees a fresh object and re-renders.
 */
function updateConditionAt(
  node: SoundboardCondition,
  path: number[],
  fn: (node: SoundboardCondition) => SoundboardCondition | null,
): SoundboardCondition | null {
  if (path.length === 0) return fn(node);
  if (node.type !== "group") return node; // A path cannot descend into a leaf.
  const head = path[0];
  const rest = path.slice(1);
  const children: SoundboardCondition[] = [];
  node.children.forEach((child, index) => {
    if (index !== head) {
      children.push(child);
      return;
    }
    const next = updateConditionAt(child, rest, fn);
    if (next !== null) children.push(next);
  });
  return { ...node, children };
}

/**
 * The soundboard editor — an Attio-style nested query builder.
 *
 * Every list whose rows contain text inputs is rendered with an *unkeyed* `<For keyed={false}>`: the state
 * updates immutably (each keystroke produces a new rule/condition object), and a keyed `<For>`
 * would treat the new object as a new row, remount it, and drop the input's focus mid-word.
 * The unkeyed form keys by position, so the same DOM input stays put and only its value updates.
 */
function SoundboardEditor(props: {
  board: Soundboard;
  sounds: SoundInfo[];
  onSaved: () => void;
}): JSX.Element {
  // Seeded once, owned by the operator's editing afterwards — same pattern and same `keyed`
  // justification as `ObsAudioForm` above. Rules keep their server ids so a save preserves them,
  // which is what keeps the running effect's per-rule cooldowns stable across edits. Root
  // conditions are normalised to groups so every rule renders an And/Or header.
  const initial = untrack(() => props.board.rules);

  const [rules, setRules] = createSignal<SoundboardRuleWrite[]>(
    initial.map((rule) => ({ ...rule, condition: asGroup(rule.condition) })),
  );
  /** Positions of the rules whose condition builder is folded away. Positional on purpose — it
   * follows the visual rows the operator collapsed, and move/remove adjust it below. */
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<number>>(new Set<number>());
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [issues, setIssues] = createSignal<ValidationIssue[]>([]);
  const [saved, setSaved] = createSignal(false);

  /** Replaces one field of one rule, immutably. */
  const patch = (index: number, changes: Partial<SoundboardRuleWrite>): void => {
    setRules((list) => list.map((rule, i) => (i === index ? { ...rule, ...changes } : rule)));
  };

  /** Rewrites one node of one rule's condition tree (`fn` returning `null` removes the node).
   * The root has no remove button, so `null` can never bubble all the way up. */
  const patchCondition = (
    index: number,
    path: number[],
    fn: (node: SoundboardCondition) => SoundboardCondition | null,
  ): void => {
    setRules((list) =>
      list.map((rule, i) => {
        if (i !== index) return rule;
        const next = updateConditionAt(asGroup(rule.condition), path, fn);
        return next === null ? rule : { ...rule, condition: next };
      }),
    );
  };

  const toggleCollapsed = (index: number): void => {
    setCollapsed((set) => {
      const next = new Set(set);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  };

  const remove = (index: number): void => {
    setRules((list) => list.filter((_, i) => i !== index));
    // Collapsed positions above the removed rule shift up by one.
    setCollapsed((set) => {
      const next = new Set<number>();
      for (const i of set) {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      }
      return next;
    });
  };

  /** Swaps a rule with its neighbour. Order is meaning here — first match wins — so the two
   * buttons are the editor for it. The collapsed marker travels with the rule. */
  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    setRules((list) => {
      if (target < 0 || target >= list.length) return list;
      const next = list.slice();
      const a = next[index];
      const b = next[target];
      if (a === undefined || b === undefined) return list;
      next[index] = b;
      next[target] = a;
      return next;
    });
    setCollapsed((set) => {
      if (target < 0 || target >= rules().length) return set;
      const hadA = set.has(index);
      const hadB = set.has(target);
      if (hadA === hadB) return set;
      const next = new Set(set);
      if (hadA) {
        next.delete(index);
        next.add(target);
      } else {
        next.delete(target);
        next.add(index);
      }
      return next;
    });
  };

  const add = (): void => {
    // No `id`: the server assigns one on save. Enabled by default — a rule someone writes is a
    // rule they want live; the checkbox is for switching one off without deleting it.
    setRules((list) => [...list, { label: "", condition: emptyGroup(), sound: "", enabled: true }]);
  };

  /*
   * One audio element for every ▶ button, reused: pressing a second preview stops the first
   * instead of layering over it, and nothing leaks when the card unmounts.
   */
  const preview = new Audio();
  onCleanup(() => {
    preview.pause();
    preview.removeAttribute("src");
    preview.load();
  });

  const playPreview = (soundName: string): void => {
    if (soundName.trim() === "") return;
    preview.src = soundAudioUrl(soundName.trim());
    preview.currentTime = 0;
    // A missing sound or a blocked autoplay is not worth a banner — the button did nothing, which
    // is itself the answer, and the rule may name a clip that is not uploaded yet.
    void preview.play().catch(() => undefined);
  };

  /** The message a save's validation error attached to this exact dotted field, if any. */
  const issueFor = (field: string): string | null =>
    issues().find((issue) => issue.field === field)?.message ?? null;

  /* --- The live test box: the shared evaluator run against a synthetic message ---------- */

  const [testText, setTestText] = createSignal("");
  const [testEvent, setTestEvent] = createSignal<SoundboardEventValue>("chat");
  const [testEmote, setTestEmote] = createSignal(false);
  const [testEmoji, setTestEmoji] = createSignal(false);

  /** Whether the test box holds anything worth evaluating. No input, no badges — an all-blank
   * probe matching a "contains ''" rule would be noise, not information. */
  const testActive = (): boolean =>
    testText().trim() !== "" || testEmote() || testEmoji() || testEvent() !== "chat";

  /** A synthetic ChatMessage shaped like what the chat bus delivers, fed to the shared matcher. */
  const testMessage = createMemo((): ChatMessage => {
    const parts: ChatPart[] = [];
    if (testText() !== "") parts.push({ type: "text", text: testText() });
    if (testEmote()) {
      parts.push({
        type: "image",
        name: "TestEmote",
        // A Twitch-CDN-shaped URL: the matcher tells emotes and emoji apart by URL origin.
        url: "https://static-cdn.jtvnw.net/emoticons/v2/0/default/dark/2.0",
      });
    }
    if (testEmoji()) {
      parts.push({
        type: "image",
        name: "🎉",
        url: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f389.png",
      });
    }
    return {
      id: "test",
      at: 0,
      channel: "test",
      username: "testuser",
      displayName: "TestUser",
      color: "#ffffff",
      seed: 0,
      event: testEvent(),
      text: testText(),
      parts,
      data: {},
    };
  });

  /** Every rule compiled on its own, enabled or not, so each one can show a badge. This is the
   * SAME `compileSoundboard`/`matchRule` the overlay effect runs — that is the whole point. */
  const prepared = createMemo(() =>
    rules().map(
      (rule, i) =>
        compileSoundboard({
          rules: [{ ...rule, id: rule.id ?? `unsaved-${i}`, enabled: true }],
        })[0] ?? null,
    ),
  );

  const testResultFor = (index: number): boolean | null => {
    if (!testActive()) return null;
    const rule = prepared()[index];
    if (rule === undefined || rule === null) return null;
    return matchRule(rule, testMessage());
  };

  /** Which rule would actually fire: the first *enabled* match, mirroring the overlay. */
  const firingIndex = createMemo((): number => {
    if (!testActive()) return -1;
    const msg = testMessage();
    const list = rules();
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.enabled !== true) continue;
      const rule = prepared()[i];
      if (rule !== undefined && rule !== null && matchRule(rule, msg)) return i;
    }
    return -1;
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateSoundboard({ rules: rules() });
      setIssues([]);
      setSaved(true);
      props.onSaved();
    } catch (cause) {
      // Field-level issues light up next to the offending row; anything that cannot be placed
      // (or a non-validation failure) still lands in the list and banner below.
      setIssues(cause instanceof ApiError ? cause.issues : []);
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <Show when={rules().length === 0}>
        <p class="muted">No rules yet — add one below.</p>
      </Show>

      <For each={rules()} keyed={false}>
        {(rule, index) => (
          <SoundboardRuleEditor
            rule={rule}
            index={index}
            count={() => rules().length}
            sounds={props.sounds}
            collapsed={() => collapsed().has(index)}
            testResult={() => testResultFor(index)}
            fires={() => firingIndex() === index}
            issueFor={issueFor}
            onToggleCollapsed={() => toggleCollapsed(index)}
            onPatch={(changes) => patch(index, changes)}
            onCondition={(path, fn) => patchCondition(index, path, fn)}
            onMove={(delta) => move(index, delta)}
            onRemove={() => remove(index)}
            onPreview={playPreview}
          />
        )}
      </For>

      <div class="btn-row">
        <button type="button" class="btn" onClick={add} disabled={rules().length >= 100}>
          Add rule
        </button>
        <button type="submit" class="btn btn-primary" disabled={saving()}>
          {saving() ? "Saving…" : "Save soundboard"}
        </button>
        <Show when={saved()}>
          <span class="muted">Saved.</span>
        </Show>
      </div>
      <p class="field-help">
        Each rule fires when its conditions hold for a message: <em>Command</em> compares the first
        word case-insensitively ("!drum" as chat would type it), <em>Contains text</em> looks for a
        case-insensitive substring, <em>Regex</em> is a JavaScript regular expression over the
        whole text, <em>Has emote</em>/<em>Has emoji</em> match any (or one named) emote or emoji,
        and groups nest with And/Or and NOT. Running overlays pick up a save within a minute.
      </p>

      <div class="field sb-test">
        <label class="field-label" for="sb-test-text">
          Try a message against the rules
        </label>
        <div class="sb-test-row">
          <input
            id="sb-test-text"
            type="text"
            value={testText()}
            spellcheck={false}
            onInput={(event) => setTestText(event.currentTarget.value)}
            placeholder="type a test message…"
          />
          <select
            value={testEvent()}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              setTestEvent(
                (SOUNDBOARD_EVENTS as string[]).includes(raw)
                  ? (raw as SoundboardEventValue)
                  : "chat",
              );
            }}
            aria-label="Test event kind"
          >
            <For each={SOUNDBOARD_EVENTS}>{(kind) => <option value={kind}>{kind}</option>}</For>
          </select>
          <button
            type="button"
            class={["btn", "btn-sm", "sb-chip", { "sb-chip-on": testEmote() }]}
            onClick={() => setTestEmote((on) => !on)}
          >
            has emote
          </button>
          <button
            type="button"
            class={["btn", "btn-sm", "sb-chip", { "sb-chip-on": testEmoji() }]}
            onClick={() => setTestEmoji((on) => !on)}
          >
            has emoji
          </button>
        </div>
        <p class="field-help">
          Evaluated with the exact matcher the overlay runs, so a "match" badge on a rule above
          means the overlay would react — and "plays" marks the one that wins (first enabled
          match). The chips stand in for a message carrying <em>some</em> emote or emoji;
          conditions naming a specific one only match real messages that carry it. The test sender
          is "TestUser".
        </p>
      </div>

      <Show when={issues().length > 0}>
        {/* The fallback list: every issue verbatim, including any whose dotted path did not line
            up with a rendered row (for example after rows were edited since the failed save). */}
        <ul class="sb-issues">
          <For each={issues()}>
            {(issue) => (
              <li>
                <code>{issue.field}</code> — {issue.message}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Banner kind="error" message={error()} />
    </form>
  );
}

/** One rule: a header row (label, sound, preview, enabled, order, collapse, delete, test badge)
 * above its recursive condition builder. */
function SoundboardRuleEditor(props: {
  rule: () => SoundboardRuleWrite;
  index: number;
  count: () => number;
  sounds: SoundInfo[];
  collapsed: () => boolean;
  /** `null` while the test box is blank, otherwise whether the test message matches this rule. */
  testResult: () => boolean | null;
  /** Whether this rule is the one that would actually play (first enabled match). */
  fires: () => boolean;
  issueFor: (field: string) => string | null;
  onToggleCollapsed: () => void;
  onPatch: (changes: Partial<SoundboardRuleWrite>) => void;
  onCondition: (
    path: number[],
    fn: (node: SoundboardCondition) => SoundboardCondition | null,
  ) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onPreview: (soundName: string) => void;
}): JSX.Element {
  /** Whether the rule references a sound the listing does not know. Such a rule saves fine — the
   * contract does not enforce existence — but the picker falls back to a text box for it. */
  const isKnownSound = (name: string): boolean =>
    name === "" || props.sounds.some((sound) => sound.name === name);

  /** Whether the sound is typed by hand instead of picked from the listing. Decided once, from
   * whether the saved value is a listed sound — never re-derived while the operator types, so
   * the text box cannot be swapped out (and lose focus) mid-word just because the typed prefix
   * happens to equal a listed name. The button next to the picker flips the mode explicitly. */
  const [soundFreeText, setSoundFreeText] = createSignal(
    untrack(() => !isKnownSound(props.rule().sound)),
  );

  const field = (suffix: string): string => `rules[${props.index}].${suffix}`;
  const rootGroup = (): SoundboardGroupCondition => asGroup(props.rule().condition);

  return (
    <div class="field sb-rule">
      <div class="sb-rule-head">
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => props.onToggleCollapsed()}
          title={props.collapsed() ? "Expand the conditions" : "Collapse the conditions"}
        >
          {props.collapsed() ? "▸" : "▾"}
        </button>
        <input
          type="text"
          value={props.rule().label}
          spellcheck={false}
          onInput={(event) => props.onPatch({ label: event.currentTarget.value })}
          placeholder="Label, e.g. Drum roll"
          aria-label="Rule label"
        />
        <Show
          when={!soundFreeText()}
          fallback={
            <input
              type="text"
              value={props.rule().sound}
              spellcheck={false}
              onInput={(event) => props.onPatch({ sound: event.currentTarget.value })}
              placeholder="Sound name"
              aria-label="Sound name (typed by hand)"
            />
          }
        >
          <select
            value={props.rule().sound}
            onChange={(event) => props.onPatch({ sound: event.currentTarget.value })}
            aria-label="Sound"
          >
            <option value="">— pick a sound —</option>
            <For each={props.sounds}>{(sound) => <option value={sound.name}>{sound.name}</option>}</For>
          </select>
        </Show>
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => setSoundFreeText(!soundFreeText())}
          title={
            soundFreeText()
              ? "Pick the sound from the listing instead"
              : "Type a sound name by hand (for a sound not in the listing)"
          }
        >
          {soundFreeText() ? "List" : "Type"}
        </button>
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => props.onPreview(props.rule().sound)}
          disabled={props.rule().sound.trim() === ""}
          title="Play this sound"
        >
          ▶
        </button>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={props.rule().enabled}
            onChange={(event) => props.onPatch({ enabled: event.currentTarget.checked })}
          />
          <span>Enabled</span>
        </label>
        <Show when={props.testResult() !== null}>
          <span class={["sb-badge", { "sb-badge-match": props.testResult() === true }]}>
            {props.testResult() === true ? (props.fires() ? "match · plays" : "match") : "no match"}
          </span>
        </Show>
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => props.onMove(-1)}
          disabled={props.index === 0}
          title="Move up (rules are checked top to bottom)"
        >
          ↑
        </button>
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => props.onMove(1)}
          disabled={props.index === props.count() - 1}
          title="Move down"
        >
          ↓
        </button>
        <button type="button" class="btn btn-sm" onClick={() => props.onRemove()}>
          Remove
        </button>
      </div>

      <Show when={props.issueFor(field("label"))}>
        {(message) => <p class="field-error">{message()}</p>}
      </Show>
      <Show when={props.issueFor(field("sound"))}>
        {(message) => <p class="field-error">{message()}</p>}
      </Show>

      <Show when={!props.collapsed()}>
        <SoundboardGroupEditor
          group={rootGroup}
          depth={1}
          path={[]}
          fieldPath={field("condition")}
          issueFor={props.issueFor}
          update={props.onCondition}
          onRemove={null}
        />
      </Show>
    </div>
  );
}

/**
 * One group of the condition tree: the "If all/any of the following are true" header with its
 * And/Or dropdown and NOT toggle, the child rows (conditions and nested groups, via an unkeyed `<For>` —
 * see `SoundboardEditor`'s comment), and the add buttons. Renders itself recursively for
 * subgroups, each one indented a level deeper.
 */
function SoundboardGroupEditor(props: {
  group: () => SoundboardGroupCondition;
  /** 1 for the rule's root group; subgroups stop appearing at {@link MAX_TREE_DEPTH}. */
  depth: number;
  /** Child indexes from the root down to this group — the address `update` rewrites at. */
  path: number[];
  /** Dotted path of this group in the save request, e.g. "rules[2].condition.children[0]". */
  fieldPath: string;
  update: (path: number[], fn: (node: SoundboardCondition) => SoundboardCondition | null) => void;
  issueFor: (field: string) => string | null;
  /** `null` for the root group, which cannot be removed. */
  onRemove: (() => void) | null;
}): JSX.Element {
  const setSelf = (changes: Partial<SoundboardGroupCondition>): void => {
    props.update(props.path, (node) => (node.type === "group" ? { ...node, ...changes } : node));
  };

  const addChild = (child: SoundboardCondition): void => {
    props.update(props.path, (node) =>
      node.type === "group" ? { ...node, children: [...node.children, child] } : node,
    );
  };

  const full = (): boolean => props.group().children.length >= MAX_GROUP_CHILDREN;

  return (
    <div class={["sb-group", { "sb-group-negated": props.group().negate }]}>
      <div class="sb-group-head">
        <span class="sb-group-word">If</span>
        <button
          type="button"
          class={["btn", "btn-sm", "sb-chip", { "sb-chip-on": props.group().negate }]}
          onClick={() => setSelf({ negate: !props.group().negate })}
          title="Invert this group: match when its combined result is false"
        >
          NOT
        </button>
        <select
          value={props.group().op}
          onChange={(event) => setSelf({ op: event.currentTarget.value === "or" ? "or" : "and" })}
          aria-label="Combine the conditions with"
        >
          <option value="and">all</option>
          <option value="or">any</option>
        </select>
        <span class="sb-group-word">of the following are true</span>
        <Show when={props.onRemove !== null}>
          <button
            type="button"
            class="btn btn-sm sb-group-remove"
            onClick={() => props.onRemove?.()}
          >
            Remove group
          </button>
        </Show>
      </div>

      <Show when={props.issueFor(`${props.fieldPath}.children`)}>
        {(message) => <p class="field-error">{message()}</p>}
      </Show>

      <div class="sb-children">
        <For each={props.group().children} keyed={false}>
          {(child, childIndex) => {
            const childPath = [...props.path, childIndex];
            const childField = `${props.fieldPath}.children[${childIndex}]`;
            // A group must never end up with zero children: the backend rejects an empty
            // `children` array, while the shared evaluator would treat it as matching
            // everything — so the last remaining child of a group cannot be removed.
            const lastChild = (): boolean => props.group().children.length <= 1;
            return (
              <Show
                when={child().type === "group"}
                fallback={
                  <SoundboardConditionRow
                    condition={() => child() as SoundboardLeafCondition}
                    field={childField}
                    issueFor={props.issueFor}
                    onChange={(leaf) => props.update(childPath, () => leaf)}
                    onRemove={() => props.update(childPath, () => null)}
                    removable={() => !lastChild()}
                  />
                }
              >
                <SoundboardGroupEditor
                  group={() => child() as SoundboardGroupCondition}
                  depth={props.depth + 1}
                  path={childPath}
                  fieldPath={childField}
                  update={props.update}
                  issueFor={props.issueFor}
                  onRemove={lastChild() ? null : () => props.update(childPath, () => null)}
                />
              </Show>
            );
          }}
        </For>
      </div>

      <div class="btn-row sb-group-foot">
        <button type="button" class="btn btn-sm" onClick={() => addChild(emptyLeaf())} disabled={full()}>
          + Add condition
        </button>
        {/* Hidden (not disabled) at the depth cap: at level 5 a subgroup is not a thing that can
            exist, so there is nothing to explain with a greyed-out button. */}
        <Show when={props.depth < MAX_TREE_DEPTH}>
          <button
            type="button"
            class="btn btn-sm"
            onClick={() => addChild(emptyGroup())}
            disabled={full()}
          >
            + Add subgroup
          </button>
        </Show>
      </div>
    </div>
  );
}

/** One leaf row: a type dropdown and the right value editor for that type — a select of the five
 * event kinds for "event", a text box for everything else. */
function SoundboardConditionRow(props: {
  condition: () => SoundboardLeafCondition;
  /** Dotted path of this condition in the save request, for placing validation errors. */
  field: string;
  issueFor: (field: string) => string | null;
  onChange: (leaf: SoundboardLeafCondition) => void;
  onRemove: () => void;
  /** `false` for a group's last remaining condition, which must stay — see the caller's comment. */
  removable: () => boolean;
}): JSX.Element {
  const retype = (raw: string): void => {
    const type = (LEAF_TYPES as string[]).includes(raw) ? (raw as SoundboardLeafType) : "command";
    // The typed value survives a kind switch (retyping "!drum" because the dropdown moved would
    // be hostile), except into "event", whose value must be one of the five kinds.
    const kept = props.condition().value;
    const value =
      type === "event" ? ((SOUNDBOARD_EVENTS as string[]).includes(kept) ? kept : "chat") : kept;
    props.onChange({ type, value });
  };

  const rowError = (): string | null =>
    props.issueFor(`${props.field}.value`) ??
    props.issueFor(`${props.field}.type`) ??
    props.issueFor(props.field);

  return (
    <div class="sb-condition">
      <div class="sb-condition-row">
        <select
          value={props.condition().type}
          onChange={(event) => retype(event.currentTarget.value)}
          aria-label="Condition kind"
        >
          <For each={LEAF_TYPES}>
            {(type) => <option value={type}>{LEAF_TYPE_LABELS[type]}</option>}
          </For>
        </select>
        <Show
          when={props.condition().type === "event"}
          fallback={
            <input
              type="text"
              value={props.condition().value}
              spellcheck={false}
              onInput={(event) =>
                props.onChange({ ...props.condition(), value: event.currentTarget.value })
              }
              placeholder={LEAF_PLACEHOLDERS[props.condition().type]}
              aria-label="Condition value"
            />
          }
        >
          <select
            value={props.condition().value}
            onChange={(event) =>
              props.onChange({ ...props.condition(), value: event.currentTarget.value })
            }
            aria-label="Event kind"
          >
            <For each={SOUNDBOARD_EVENTS}>{(kind) => <option value={kind}>{kind}</option>}</For>
          </select>
        </Show>
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => props.onRemove()}
          disabled={!props.removable()}
          title={
            props.removable()
              ? "Remove condition"
              : "A group needs at least one condition — remove the whole group instead"
          }
        >
          ✕
        </button>
      </div>
      <Show when={rowError()}>{(message) => <p class="field-error">{message()}</p>}</Show>
    </div>
  );
}

function SoundUploadForm(props: { onUploaded: () => void }): JSX.Element {
  const [file, setFile] = createSignal<File | null>(null);
  const [name, setName] = createSignal("");
  /** Whether the operator has typed in the name box, so picking a new file stops renaming it. */
  const [nameTouched, setNameTouched] = createSignal(false);
  const [uploading, setUploading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  let fileInput: HTMLInputElement | undefined;

  function pick(picked: File | null): void {
    setFile(picked);
    // Defaulting the name from the filename (minus its extension) saves typing the common case;
    // a name the operator already edited is theirs and is left alone.
    if (picked !== null && !nameTouched()) {
      setName(picked.name.replace(/\.[^.]+$/, ""));
    }
  }

  async function upload(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const picked = file();
    if (picked === null) return;
    setUploading(true);
    setError(null);
    try {
      await uploadSound(name().trim(), picked);
      setFile(null);
      setName("");
      setNameTouched(false);
      if (fileInput !== undefined) fileInput.value = "";
      props.onUploaded();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={(event) => void upload(event)}>
      <div class="field">
        <label class="field-label" for="sound-file">
          Upload a sound
        </label>
        <input
          id="sound-file"
          type="file"
          ref={(el) => {
            fileInput = el;
          }}
          accept="audio/mpeg,audio/ogg,audio/wav,audio/webm,.mp3,.ogg,.wav,.webm"
          onChange={(event) => pick(event.currentTarget.files?.[0] ?? null)}
        />
        <p class="field-help">
          MP3, Ogg, WAV or WebM, up to 5 MB. Keep clips short — they play over the stream.
        </p>
      </div>
      <div class="field">
        <label class="field-label" for="sound-name">
          Name
        </label>
        <input
          id="sound-name"
          type="text"
          value={name()}
          spellcheck={false}
          onInput={(event) => {
            setNameTouched(true);
            setName(event.currentTarget.value);
          }}
          placeholder="Defaults to the file name"
        />
        <p class="field-help">
          How effects refer to this clip. The playback URL accepts this name directly, so renaming
          a clip means updating any effect configured to use the old name.
        </p>
      </div>
      <div class="btn-row">
        <button
          type="submit"
          class="btn btn-primary"
          disabled={uploading() || file() === null || name().trim() === ""}
        >
          {uploading() ? "Uploading…" : "Upload"}
        </button>
      </div>
      <Banner kind="error" message={error()} />
    </form>
  );
}
