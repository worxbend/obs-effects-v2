import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  banTwitchUsers,
  describeError,
  getTwitchAdminStatus,
  listTwitchBans,
  unbanTwitchUsers,
} from "~/api/client";
import { Banner } from "~/components/Banner";
import type {
  BulkResult,
  TwitchAdminStatus,
  TwitchBan,
  TwitchUnbanTarget,
} from "~/types/contract";

/**
 * `/admin/twitch` — moderating the connected Twitch channel: what the connection can do, the
 * channel's ban list, and bulk ban / timeout / unban.
 *
 * ## This whole page is optional, and that is the first thing it has to get right
 *
 * A stream can use this project without ever giving it Twitch credentials, and a stream that only
 * wants chat overlays needs nothing but a channel name — Twitch allows anonymous read-only chat.
 * Neither of those installations can moderate anything, and neither of them is broken.
 *
 * So the page asks exactly one question on mount, `GET /api/twitch/admin/status`, which always
 * answers 200 (see `getTwitchAdminStatus`). If the answer is "not available" the page renders one
 * card explaining what is missing and linking to Settings, and **stops**: no table, no forms, no
 * further requests, and nothing in the browser console. Everything that could fail lives inside
 * {@link TwitchAdminDashboard}, which is only ever mounted once the answer said `available: true`.
 */
export default function TwitchAdminPage(): JSX.Element {
  /*
   * An **async memo**: a `createMemo` whose function returns a promise, which is how this codebase
   * loads data (Solid 2 has no `createResource`). Reading `status()` before it settles suspends
   * and the enclosing `<Loading>` shows its fallback; a rejection is caught by `<Errored>`.
   */
  const status = createMemo(() => getTwitchAdminStatus());

  return (
    <>
      <div class="page-head">
        <div>
          <h1>Twitch</h1>
          <p>
            Moderation for the channel this server is connected to: browse the ban list, lift bans,
            and ban or time out many accounts at once.
          </p>
        </div>
      </div>

      <Errored fallback={(failure) => <Banner kind="error" message={describeError(failure())} />}>
        <Loading fallback={<p class="muted">Checking the Twitch connection…</p>}>
          {/*
            `keyed` hands the settled value to the child function, so everything below reads a
            plain `TwitchAdminStatus` rather than re-reading a memo that could suspend again.
          */}
          <Show when={status()} keyed>
            {(info: TwitchAdminStatus) => (
              <Show when={info.available} fallback={<TwitchUnavailableCard status={info} />}>
                <TwitchAdminDashboard status={info} />
              </Show>
            )}
          </Show>
        </Loading>
      </Errored>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The unavailable state                                               */
/* ------------------------------------------------------------------ */

/**
 * The only thing on screen when moderation cannot run: what is missing, and where to fix it.
 *
 * It deliberately renders no controls at all. A disabled table or a form that answers 409 on
 * submit would look like a fault in the application, when the real situation is that this
 * installation has not been given permission to moderate — which is a normal way to run it.
 */
function TwitchUnavailableCard(props: { status: TwitchAdminStatus }): JSX.Element {
  return (
    <section class="card">
      <div class="card-title">
        <h2>Moderation is not set up</h2>
      </div>
      <p>
        {props.status.reason ??
          "Twitch moderation is not available on this installation right now."}
      </p>

      {/*
        A "scope" is one permission granted when the account signed in with Twitch. A token
        obtained before this page existed only asked for `chat:read`, which reads chat perfectly
        well and cannot ban anybody — so this case is common, expected, and fixed by reconnecting.
      */}
      <Show when={props.status.missingScopes.length > 0}>
        <div class="field">
          <span class="field-label">Missing permissions</span>
          <div class="tag-row">
            <For each={props.status.missingScopes}>
              {(scope) => <span class="tag">{scope}</span>}
            </For>
          </div>
          <p class="field-help">
            The connected account granted the other permissions but not these. Press “Connect with
            Twitch” again on the Settings page: the sign-in now asks for the moderation permissions
            too, and approving it replaces the stored token. Chat keeps working either way — an
            older token is never a reason for the overlays to stop.
          </p>
        </div>
      </Show>

      <div class="btn-row">
        <a class="btn btn-primary" href="/admin/settings">
          Open Settings
        </a>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The available state                                                 */
/* ------------------------------------------------------------------ */

/** How many bans one page of the list asks for. 100 is Twitch's own maximum per request. */
const BAN_PAGE_SIZE = 100;

/** The most accounts one bulk request may carry — the backend refuses more. */
const MAX_BULK_USERS = 100;

/** Twitch's own limit on a timeout: 14 days, in seconds. Longer means "ban permanently". */
const MAX_TIMEOUT_SECONDS = 1_209_600;

/** Which bans the table is showing. */
type BanFilter = "all" | "permanent" | "timed";

/** Which bulk action the form will perform. */
type BulkAction = "ban" | "timeout";

/**
 * Everything that is on screen once moderation is available: the channel summary, the ban list,
 * and the bulk form.
 *
 * The ban list's state lives here rather than inside the table, because two panels need it: the
 * table draws it, and a finished bulk action has to reload it. Passing one small object of
 * accessors and actions down to both is less machinery than making a child expose a handle upward.
 */
function TwitchAdminDashboard(props: { status: TwitchAdminStatus }): JSX.Element {
  const bans = createBanList();

  /*
   * `onSettled` is Solid 2's replacement for `onMount`: it runs once, after the first render has
   * settled. The first page of bans is fetched here rather than in an async memo because the list
   * *grows* — "Load more" appends the next cursor page to what is already on screen — and a memo
   * that owns the whole list would have to re-fetch every page it had already shown.
   */
  onSettled(() => {
    void bans.reload();
  });

  return (
    <>
      <TwitchSummaryCard status={props.status} />
      <BanListCard list={bans} />
      <BulkActionsCard onCompleted={() => void bans.reload()} />
    </>
  );
}

/** Panel 1: who this server is moderating as, and with which permissions. */
function TwitchSummaryCard(props: { status: TwitchAdminStatus }): JSX.Element {
  return (
    <section class="card">
      <div class="card-title">
        <h2>Channel</h2>
      </div>
      <dl class="twitch-summary">
        <dt>Channel</dt>
        <dd>
          <code>{props.status.channel}</code>
        </dd>

        <dt>Broadcaster ID</dt>
        <dd>
          <code>{props.status.broadcasterId ?? "unknown"}</code>
        </dd>

        <dt>Moderating as</dt>
        <dd>
          <Show when={props.status.moderatorLogin} fallback={<span class="faint">unknown</span>}>
            {(login) => <code>{login()}</code>}
          </Show>
        </dd>

        <dt>Permissions</dt>
        <dd>
          <div class="tag-row">
            <For each={props.status.grantedScopes}>
              {(scope) => <span class="tag">{scope}</span>}
            </For>
          </div>
        </dd>
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The ban list                                                        */
/* ------------------------------------------------------------------ */

/** The ban list's state and the two things anyone does to it. See {@link createBanList}. */
interface BanListState {
  bans: () => TwitchBan[];
  /** True while a request is in flight, so buttons can disable themselves. */
  busy: () => boolean;
  /** The last failure, in words, or `null`. */
  error: () => string | null;
  /** True once at least one page has arrived, so "no bans" is not shown before the first load. */
  loaded: () => boolean;
  /** True when Twitch says there is another page to fetch. */
  hasMore: () => boolean;
  /** Throws away what is on screen and fetches the first page again. */
  reload: () => Promise<void>;
  /** Fetches the page after the one on screen and appends it. */
  loadMore: () => Promise<void>;
}

/**
 * Builds the ban list's state.
 *
 * A plain function rather than a component: it only creates signals and closures, so it can be
 * called from a component body and the two panels can share the result.
 *
 * Paging is **cursor-based** because that is all Twitch offers — an opaque token meaning "the page
 * after the one you just read", with no way to jump to a numbered page. So the list only ever
 * grows forwards, which is why "Load more" appends instead of replacing.
 */
function createBanList(): BanListState {
  const [bans, setBans] = createSignal<TwitchBan[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);

  /*
   * Which fetch is the current one. Every call takes the next number and, when its response
   * arrives, throws the response away unless it still holds the highest number.
   *
   * Without this, two fetches can be in flight at once — press "Load more", then unban a row,
   * which reloads the list — and whichever answers *last* wins. If that is the older "Load more",
   * its stale page is appended to the freshly reloaded list (so a viewer who was just unbanned
   * reappears) and the cursor is moved past a page the reload never fetched (so the next
   * "Load more" skips entries). Ignoring superseded responses makes the newest request the only
   * one that can change what is on screen.
   */
  let generation = 0;

  /**
   * One page fetch. `append` is false for a reload and true for "Load more"; everything else about
   * the two is identical, which is why they are one function.
   *
   * Failures become the `error` signal rather than a rejected promise: every caller is an event
   * handler, and an unhandled rejection there would reach the console and tell the operator
   * nothing.
   */
  const fetchPage = async (append: boolean): Promise<void> => {
    generation += 1;
    const mine = generation;
    setBusy(true);
    setError(null);
    try {
      const page = await listTwitchBans({
        cursor: append ? cursor() : null,
        limit: BAN_PAGE_SIZE,
      });
      if (mine !== generation) return;
      setBans(append ? [...bans(), ...page.bans] : page.bans);
      setCursor(page.cursor);
      setLoaded(true);
    } catch (cause) {
      if (mine !== generation) return;
      setError(describeError(cause));
    } finally {
      // Only the newest request may say the list has stopped working; an older one finishing
      // would otherwise re-enable the buttons while its successor is still running.
      if (mine === generation) setBusy(false);
    }
  };

  return {
    bans,
    busy,
    error,
    loaded,
    hasMore: () => cursor() !== null,
    reload: () => fetchPage(false),
    loadMore: () => fetchPage(true),
  };
}

/** Panel 2: the ban list, with search, a permanent/timed filter, and unbanning. */
function BanListCard(props: { list: BanListState }): JSX.Element {
  const [search, setSearch] = createSignal("");
  const [filter, setFilter] = createSignal<BanFilter>("all");

  /** User ids ticked in the table. Ids, not logins, because an id is what Twitch is sure about. */
  const [selected, setSelected] = createSignal<string[]>([]);
  /** The user id of the row whose single "Unban" button is working, or `null`. */
  const [unbanningId, setUnbanningId] = createSignal<string | null>(null);
  const [bulkBusy, setBulkBusy] = createSignal(false);
  const [result, setResult] = createSignal<BulkResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  /**
   * The rows actually drawn: the loaded pages narrowed by the search box and the filter.
   *
   * Both are **client-side**, over what has been loaded, and the empty state below says so.
   * Twitch's ban endpoint has no search parameter, so a server-side search would mean walking
   * every cursor page before answering — slow, and rate-limited.
   */
  const visible = createMemo(() => {
    const needle = search().trim().toLowerCase();
    const kind = filter();
    return props.list.bans().filter((ban) => {
      if (kind === "permanent" && ban.expiresAt !== null) return false;
      if (kind === "timed" && ban.expiresAt === null) return false;
      if (needle === "") return true;
      return (
        ban.login.toLowerCase().includes(needle) || ban.displayName.toLowerCase().includes(needle)
      );
    });
  });

  /** The ticked rows that are still visible — the ones "Unban selected" will actually act on. */
  const selectedVisible = createMemo(() => {
    const ids = new Set(selected());
    return visible().filter((ban) => ids.has(ban.userId));
  });

  const allVisibleSelected = createMemo(
    () => visible().length > 0 && selectedVisible().length === visible().length,
  );

  const toggleOne = (userId: string, on: boolean): void => {
    setSelected(on ? [...selected(), userId] : selected().filter((id) => id !== userId));
  };

  const toggleAllVisible = (on: boolean): void => {
    const visibleIds = visible().map((ban) => ban.userId);
    if (on) {
      const ids = new Set([...selected(), ...visibleIds]);
      setSelected([...ids]);
      return;
    }
    const dropped = new Set(visibleIds);
    setSelected(selected().filter((id) => !dropped.has(id)));
  };

  /**
   * Lifts the bans on `targets` and reloads the list.
   *
   * Unbanning goes through the same bulk endpoint whether it is one row's button or fifty ticked
   * boxes, so there is one code path and one kind of result to read.
   *
   * Every row of the ban list arrived from Twitch with its numeric user id, and that id is what is
   * sent. Sending the login instead would make the backend look the name up again just before
   * acting — and a Twitch login can be renamed, then claimed by a *different* account. If that
   * happened between loading the list and pressing the button, the lookup would answer with the
   * new owner and the request would unban a stranger while the account the operator picked stayed
   * banned. An id cannot drift like that, so the id is what travels. The login goes along only so
   * the report below can name people the way the operator sees them.
   *
   * The list is sent in chunks of at most {@link MAX_BULK_USERS}, because the backend rejects a
   * longer list outright — and "rejected outright" is the worst possible answer here: the operator
   * would see a validation error and *nobody* would be unbanned. (The cap counts `targets` and
   * `users` together; this panel only ever sends `targets`, so the chunk length is the whole of
   * it.) Selecting more than one page's worth of rows is easy ("Load more" then tick the header
   * box), so the page splits the work rather than refusing it. The chunks are sent one after
   * another, and their outcomes are concatenated into a single result so the report below still
   * reads as one action.
   */
  const unban = async (targets: TwitchUnbanTarget[]): Promise<void> => {
    setError(null);
    setResult(null);
    try {
      const combined: BulkResult = { succeeded: 0, failed: 0, outcomes: [] };
      for (let index = 0; index < targets.length; index += MAX_BULK_USERS) {
        const outcome = await unbanTwitchUsers({
          targets: targets.slice(index, index + MAX_BULK_USERS),
        });
        combined.succeeded += outcome.succeeded;
        combined.failed += outcome.failed;
        combined.outcomes = [...combined.outcomes, ...outcome.outcomes];
      }
      setResult(combined);
      setSelected([]);
      await props.list.reload();
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const unbanOne = async (ban: TwitchBan): Promise<void> => {
    setUnbanningId(ban.userId);
    try {
      await unban([{ userId: ban.userId, login: ban.login }]);
    } finally {
      setUnbanningId(null);
    }
  };

  const unbanSelected = async (): Promise<void> => {
    setBulkBusy(true);
    try {
      await unban(selectedVisible().map((ban) => ({ userId: ban.userId, login: ban.login })));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <section class="card">
      <div class="card-title">
        <h2>Ban list</h2>
        <button
          type="button"
          class="btn btn-sm"
          disabled={props.list.busy()}
          onClick={() => void props.list.reload()}
        >
          {props.list.busy() ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div class="twitch-filters">
        <input
          type="text"
          value={search()}
          placeholder="Search the loaded rows by name"
          aria-label="Search bans"
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
        <select
          value={filter()}
          aria-label="Ban kind"
          onChange={(event) => setFilter(event.currentTarget.value as BanFilter)}
        >
          <option value="all">All bans</option>
          <option value="permanent">Permanent only</option>
          <option value="timed">Timeouts only</option>
        </select>
        <button
          type="button"
          class="btn btn-sm"
          disabled={selectedVisible().length === 0 || bulkBusy()}
          onClick={() => void unbanSelected()}
        >
          {bulkBusy() ? "Unbanning…" : `Unban selected (${selectedVisible().length})`}
        </button>
      </div>

      <Banner kind="error" message={props.list.error()} />
      <Banner kind="error" message={error()} />
      <BulkResultReport result={result()} verb="unbanned" />

      <Show
        when={props.list.bans().length > 0}
        fallback={
          <Show when={props.list.loaded()} fallback={<p class="muted">Loading the ban list…</p>}>
            <div class="empty">
              <p>Nobody is banned in this channel.</p>
            </div>
          </Show>
        }
      >
        <Show
          when={visible().length > 0}
          fallback={<p class="muted">No loaded ban matches this search or filter.</p>}
        >
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="col-tick">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected()}
                      aria-label="Select every visible ban"
                      onChange={(event) => toggleAllVisible(event.currentTarget.checked)}
                    />
                  </th>
                  <th>User</th>
                  <th>Reason</th>
                  <th>Banned by</th>
                  <th>Banned at</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {/*
                  `keyed={false}` — the rows contain checkboxes. An unkeyed `<For>` keys by
                  position and updates the existing DOM row in place; the keyed form would treat a
                  freshly fetched object for the same user as a new row, remount it, and take the
                  tick (and any focus) with it. Solid 2 has no `<Index>` to reach for instead.
                */}
                <For each={visible()} keyed={false}>
                  {(ban) => (
                    <tr>
                      <td class="col-tick">
                        <input
                          type="checkbox"
                          checked={selected().includes(ban().userId)}
                          aria-label={`Select ${ban().login}`}
                          onChange={(event) => toggleOne(ban().userId, event.currentTarget.checked)}
                        />
                      </td>
                      <td>
                        <strong>{ban().displayName}</strong>{" "}
                        <span class="faint mono">{ban().login}</span>
                      </td>
                      <td>
                        <Show when={ban().reason} fallback={<span class="faint">—</span>}>
                          {(reason) => <>{reason()}</>}
                        </Show>
                      </td>
                      <td class="faint">{ban().moderatorLogin ?? "—"}</td>
                      <td class="faint">
                        <Show when={ban().createdAt} fallback={<span class="faint">—</span>}>
                          {(created) => <>{formatTime(created())}</>}
                        </Show>
                      </td>
                      <td>
                        <Show
                          when={ban().expiresAt}
                          fallback={<span class="badge badge-missing">permanent</span>}
                        >
                          {(expires) => <span class="faint">{formatTime(expires())}</span>}
                        </Show>
                      </td>
                      <td>
                        <div class="cell-actions">
                          <button
                            type="button"
                            class="btn btn-sm"
                            disabled={unbanningId() === ban().userId}
                            onClick={() => void unbanOne(ban())}
                          >
                            {unbanningId() === ban().userId ? "Unbanning…" : "Unban"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>

      <Show when={props.list.hasMore()}>
        <div class="btn-row">
          <button
            type="button"
            class="btn"
            disabled={props.list.busy()}
            onClick={() => void props.list.loadMore()}
          >
            {props.list.busy() ? "Loading…" : "Load more"}
          </button>
        </div>
      </Show>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Bulk actions                                                        */
/* ------------------------------------------------------------------ */

/** The quick timeout lengths offered next to the seconds box, in seconds. */
const TIMEOUT_PRESETS: { label: string; seconds: number }[] = [
  { label: "10m", seconds: 600 },
  { label: "1h", seconds: 3600 },
  { label: "24h", seconds: 86_400 },
  { label: "7d", seconds: 604_800 },
];

/**
 * Panel 3: ban or time out a pasted list of accounts.
 *
 * Two things here are deliberate rather than decorative:
 *
 *  - **The parsed count is shown before anything is sent.** People paste lists from spreadsheets,
 *    chat logs and Discord messages, and the difference between 40 names and 400 is not visible in
 *    a textarea.
 *  - **There is a confirmation step.** A ban is not undone by pressing the button again — the
 *    banned viewer sees it, and on a list of a hundred a misclick is a hundred apologies.
 */
function BulkActionsCard(props: { onCompleted: () => void }): JSX.Element {
  const [text, setText] = createSignal("");
  const [action, setAction] = createSignal<BulkAction>("ban");
  const [duration, setDuration] = createSignal(600);
  const [reason, setReason] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<BulkResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const logins = createMemo(() => parseLogins(text()));
  const tooMany = createMemo(() => logins().length > MAX_BULK_USERS);

  /** The duration is only *valid* when it is going to be sent, which is only for a timeout. */
  const durationValid = createMemo(
    () => action() === "ban" || (duration() >= 1 && duration() <= MAX_TIMEOUT_SECONDS),
  );

  const canSubmit = createMemo(
    () => logins().length > 0 && !tooMany() && durationValid() && !busy(),
  );

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await banTwitchUsers({
        users: logins(),
        // One field decides between a ban and a timeout, because Twitch models them as one call:
        // no duration means "for good", a duration means "for this many seconds".
        durationSeconds: action() === "timeout" ? duration() : null,
        reason: reason().trim() === "" ? null : reason().trim(),
      });
      setResult(outcome);
      setConfirming(false);
      // Even a wholly failed batch is worth reloading for: the list may have moved for other
      // reasons while the operator was typing.
      props.onCompleted();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card">
      <div class="card-title">
        <h2>Bulk ban or time out</h2>
      </div>
      <p>
        Paste account names separated by new lines, commas or spaces. A leading <code>@</code> is
        ignored and duplicates are dropped, so a list copied straight out of chat works.
      </p>

      <div class="field">
        <label class="field-label" for="twitch-bulk-users">
          Accounts
        </label>
        <textarea
          id="twitch-bulk-users"
          rows="5"
          value={text()}
          placeholder="@someviewer, anotherviewer&#10;athirdviewer"
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <p class={["field-help", { "field-error": tooMany() }]}>
          {logins().length} account{logins().length === 1 ? "" : "s"} parsed
          {tooMany() ? ` — at most ${MAX_BULK_USERS} per request.` : "."}
        </p>
      </div>

      <div class="field">
        <label class="field-label" for="twitch-bulk-action">
          Action
        </label>
        <select
          id="twitch-bulk-action"
          value={action()}
          onChange={(event) => {
            setAction(event.currentTarget.value as BulkAction);
            // Changing what the button will do invalidates a confirmation given for the old one.
            setConfirming(false);
          }}
        >
          <option value="ban">Ban permanently</option>
          <option value="timeout">Time out</option>
        </select>
      </div>

      {/*
        The duration row exists only for a timeout — and note what decides that: the *action*
        select, never the number in the box. Mounting an input on the value being typed into it is
        how an input loses focus mid-keystroke.
      */}
      <Show when={action() === "timeout"}>
        <div class="field">
          <label class="field-label" for="twitch-bulk-duration">
            Duration (seconds)
          </label>
          <div class="twitch-duration-row">
            <input
              id="twitch-bulk-duration"
              type="number"
              min="1"
              max={MAX_TIMEOUT_SECONDS}
              value={duration()}
              class={durationValid() ? undefined : "invalid"}
              onInput={(event) => setDuration(Number(event.currentTarget.value))}
            />
            <For each={TIMEOUT_PRESETS}>
              {(preset) => (
                <button
                  type="button"
                  class="btn btn-sm"
                  onClick={() => setDuration(preset.seconds)}
                >
                  {preset.label}
                </button>
              )}
            </For>
          </div>
          <p class={durationValid() ? "field-help" : "field-error"}>
            Twitch allows 1 second to 14 days ({MAX_TIMEOUT_SECONDS} seconds). Anything longer has
            to be a permanent ban.
          </p>
        </div>
      </Show>

      <div class="field">
        <label class="field-label" for="twitch-bulk-reason">
          Reason (optional)
        </label>
        <input
          id="twitch-bulk-reason"
          type="text"
          value={reason()}
          placeholder="Shown to the viewer"
          onInput={(event) => setReason(event.currentTarget.value)}
        />
      </div>

      <Banner kind="error" message={error()} />
      <BulkResultReport result={result()} verb={action() === "ban" ? "banned" : "timed out"} />

      {/*
        The confirmation is an inline row rather than `window.confirm`, matching the delete
        confirmations elsewhere in the admin: it keeps the dialog in the app's own styling, and a
        native modal blocks the whole browser thread.
      */}
      <Show
        when={confirming()}
        fallback={
          <div class="btn-row">
            <button
              type="button"
              class="btn btn-danger"
              disabled={!canSubmit()}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              {action() === "ban" ? "Ban" : "Time out"} {logins().length} account
              {logins().length === 1 ? "" : "s"}
            </button>
          </div>
        }
      >
        <div class="confirm-row">
          <span>
            {action() === "ban"
              ? `Ban ${logins().length} account(s) permanently?`
              : `Time out ${logins().length} account(s) for ${duration()} seconds?`}{" "}
            This is announced to each of them and is not undone by pressing back.
          </span>
          <button
            type="button"
            class="btn btn-sm"
            disabled={busy()}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-sm btn-danger"
            disabled={busy() || !canSubmit()}
            onClick={() => void submit()}
          >
            {busy() ? "Working…" : "Yes, do it"}
          </button>
        </div>
      </Show>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

/**
 * What a bulk call did, per user.
 *
 * The headline colour is the point of this component. A batch where 99 of 100 landed is a
 * **success with notes**, not a failure — Twitch rejecting one name it has never heard of is the
 * ordinary case a bulk tool exists to absorb — so it is drawn as an informational banner with the
 * failures listed underneath, and only an entirely failed batch is drawn as an error.
 */
function BulkResultReport(props: { result: BulkResult | null; verb: string }): JSX.Element {
  return (
    <Show when={props.result}>
      {(result) => {
        const kind = (): "ok" | "info" | "error" => {
          if (result().failed === 0) return "ok";
          return result().succeeded === 0 ? "error" : "info";
        };
        const headline = (): string => {
          const { succeeded, failed } = result();
          if (failed === 0) return `${succeeded} ${props.verb}.`;
          if (succeeded === 0) return `None ${props.verb} — all ${failed} failed.`;
          return `${succeeded} ${props.verb}, ${failed} failed.`;
        };
        const failures = (): BulkResult["outcomes"] =>
          result().outcomes.filter((outcome) => !outcome.ok);

        return (
          <>
            <Banner kind={kind()} message={headline()} />
            <Show when={failures().length > 0}>
              <ul class="twitch-outcomes">
                <For each={failures()}>
                  {(outcome) => (
                    <li>
                      <code>{outcome.login}</code>
                      <span>{outcome.message ?? "failed for an unstated reason"}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        );
      }}
    </Show>
  );
}

/**
 * Turns whatever was pasted into a clean list of login names.
 *
 * Accepts new lines, commas and spaces as separators in any mixture, because that is what the
 * places people copy from produce. A leading `@` is stripped (chat writes mentions that way) and
 * names are compared case-insensitively, since Twitch logins are lowercase — `Someone` and
 * `someone` are one account, and sending both would report one of them as already banned.
 *
 * The first spelling of a name is the one kept, so the outcome list reads back the way it was
 * typed.
 */
function parseLogins(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const login = token.replace(/^@+/, "").trim();
    if (login === "") continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(login);
  }
  return result;
}

/** Shows "2026-08-23 14:07" in the viewer's own time zone instead of a raw ISO string. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
