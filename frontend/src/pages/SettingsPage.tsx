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
  audioLevelsUrl,
  chatWsUrl,
  deleteSound,
  describeError,
  getObsAudioSettings,
  getTwitchSettings,
  listSounds,
  soundAudioUrl,
  submitTwitchTokens,
  updateObsAudioSettings,
  updateTwitchSettings,
  uploadSound,
} from "~/api/client";
import type {
  AudioLevels,
  ChatMessage,
  ChatWsFrame,
  ObsAudioSettingsRequest,
  ObsAudioView,
  ObsConnectionState,
  SoundInfo,
  TwitchConnectionState,
  TwitchConnectionStatus,
  TwitchSettingsRequest,
  TwitchView,
} from "~/types/contract";
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
      case "connectedAuthed":
        return "Connected (signed in)";
      case "connectedAnonymous":
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
      case "connectedAuthed":
      case "connectedAnonymous":
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

/** The redirect URI both halves of the OAuth flow must agree on, byte for byte. */
function oauthRedirectUri(): string {
  return `${location.origin}/admin/twitch/callback`;
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

  const oauthHref = (): string => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: props.view.settings.clientId.trim(),
      redirect_uri: oauthRedirectUri(),
      scope: "chat:read",
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
            <a class="btn btn-primary" href={oauthHref()}>
              Connect with Twitch
            </a>
          </Show>
        </div>
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
