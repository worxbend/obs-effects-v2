/**
 * The shared chat input: **the Twitch chat of the configured channel**, delivered over one
 * WebSocket for the whole page.
 *
 * ## Where the messages come from
 *
 * The backend keeps a single connection to Twitch's chat servers (IRC over WebSocket) and
 * republishes what it hears on `GET /api/chat/ws`. This file reads that stream. The division of
 * labour mirrors the audio pipeline exactly: the server holds the upstream connection and the
 * credentials, every browser source shares one downstream stream each, and effects call
 * {@link useChat} without knowing any of that.
 *
 * ## Why the reconnect logic is hand-rolled here and absent from `audio.ts`
 *
 * The audio feed rides on `EventSource`, which reconnects on its own — the browser specifies that
 * behaviour, so `audio.ts` has nothing to write. `WebSocket` has **no** such behaviour: when the
 * connection drops, it is gone, and a page that does nothing about it stays silent forever. So
 * this file carries its own reconnect loop: try again after one second, double the wait on each
 * failure, cap it at fifteen seconds. The doubling stops a dead backend from being hammered once a
 * second by every open overlay; the cap keeps recovery prompt once the backend returns.
 *
 * The server also sends a heartbeat frame every few seconds of silence, and a watchdog here closes
 * any connection that stops delivering frames. That covers the failure `onclose` never reports: a
 * connection that is dead at the network level but that the socket object still believes is open —
 * unplugged cable, suspended laptop — which would otherwise look exactly like a quiet chat.
 *
 * ## The fallback is not a branch, same as audio
 *
 * When the stream is unreachable or stale, the bus emits gentle canned messages on a slow random
 * cadence and reports `source: "simulated"`. Consumers have one code path; a preview always shows
 * *something* moving, which is what makes an overlay adjustable before Twitch is configured at
 * all.
 *
 * ## Emoji become images here, on purpose
 *
 * Twitch emotes ("Kappa") arrive from the backend already split into image parts, because Twitch
 * tells the server exactly where they sit in the text. Ordinary Unicode emoji ("🎉") do not — they
 * are plain characters — so this file scans incoming text for them and replaces each with an image
 * part pointing at Twemoji, the freely hosted emoji artwork Twitter published. Doing it here keeps
 * the backend free of Unicode tables, and doing it at all means every viewer sees the same picture
 * instead of whatever their platform's emoji font draws. The scanner is a port of
 * `_split_text_emojis` from the twitch-vizer project this feature descends from, cluster rules and
 * all (skin tones, ZWJ sequences such as 👩‍💻, keycaps such as 1️⃣).
 */

import { chatWsUrl } from "~/api/client";
import type { ChatMessage, ChatPart, ChatWsFrame, TwitchConnectionStatus } from "~/types/contract";
import { publishDebug, unpublishDebug } from "./debug";
import { createSharedResource, type SharedResource } from "./lease";
import type { Scope } from "./scope";

/** How many messages the ring keeps. Matches the server's snapshot size, so a fresh connection
 * and a long-lived one agree about how much history `recent()` can return. */
const RECENT_LIMIT = 50;

/** How long the stream may deliver nothing before it is treated as dead.
 *
 * The server sends a heartbeat after every 5 seconds of silence, so a healthy quiet stream never
 * goes 12 seconds without a frame — that is two missed heartbeats plus slack. Deliberately looser
 * than audio's 6 seconds: chat reconnecting costs a visible gap in a message feed, so a single
 * delayed heartbeat should not trigger one. */
const STALE_AFTER_MS = 12_000;

/** First reconnect wait. Short, because the common failure is a backend restart measured in seconds. */
const RECONNECT_MIN_MS = 1_000;

/** Reconnect wait ceiling. The doubling stops here so recovery never lags more than 15 seconds. */
const RECONNECT_MAX_MS = 15_000;

/** How long a connection must stay open before the reconnect wait drops back to the minimum.
 * A reset at `open` would be too early: a proxy whose upstream is dead can complete the WebSocket
 * handshake and close immediately, and resetting there would retry such a server once a second
 * forever. Ten seconds of staying open is proof the far end is really serving. */
const BACKOFF_RESET_AFTER_MS = 10_000;

/** How long a socket may sit in CONNECTING before the watchdog gives up on it. Browsers do time
 * a stuck handshake out eventually, but on their own schedule; ten seconds keeps ours. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Bounds of the random gap between simulated messages. Slow enough to read as ambient chat. */
const SIMULATED_MIN_GAP_MS = 4_000;
const SIMULATED_MAX_GAP_MS = 9_000;

/** Where Twemoji's emoji images are served from, pinned to a version so URLs never move. */
const TWEMOJI_BASE = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72";

/** The chat a consumer sees. One instance exists per page, whatever `source` says. */
export interface ChatBus {
  /**
   * The most recent messages, oldest first, at most {@link RECENT_LIMIT}.
   *
   * Returns a fresh copy on every call, so holding or mutating the result cannot corrupt the
   * shared ring. Call it once in setup to seed a display; rely on {@link onMessage} after that
   * rather than polling this every frame.
   */
  recent(): ChatMessage[];
  /**
   * Subscribes to new messages and returns the matching unsubscribe function.
   *
   * Effects pair the two with their scope, so the subscription cannot outlive the effect:
   *
   * ```ts
   * const off = chat.onMessage((m) => feed.push(m));
   * scope.defer(off);
   * ```
   *
   * A listener that throws is logged and does not stop the other listeners from being called.
   */
  onMessage(listener: (message: ChatMessage) => void): () => void;
  /**
   * Where the messages come from. `"live"` while the WebSocket is open and delivering frames;
   * `"simulated"` when there is no connection or the stream has gone stale.
   *
   * It can change at any time in either direction. Do not cache it.
   */
  readonly source: "live" | "simulated";
  /**
   * The backend's last report of what its own Twitch connection is doing, or `null` before the
   * first report arrives. Note the two hops: this page connects to the backend, and the backend
   * connects to Twitch. `source` describes the first hop; this describes the second.
   */
  status(): TwitchConnectionStatus | null;
}

/** Everything the page-wide chat connection owns, so `destroy` can take it all down. */
interface ChatFeed {
  bus: ChatBus;
  close(): void;
}

/* ------------------------------------------------------------------ */
/* Unicode emoji → Twemoji image parts                                 */
/* ------------------------------------------------------------------ */

/** True for the code points that can *start* an emoji: the main emoji blocks plus the older
 * miscellaneous-symbol ranges (☀..➿, ⌚..⏳) that emoji fonts render as pictures. */
function isEmojiBase(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2300 && codePoint <= 0x23ff)
  );
}

/** True for the regional-indicator letters (U+1F1E6..U+1F1FF); two in a row make a flag, 🇺🇸. */
function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

/** True for the code points that *extend* an emoji rather than standing alone: the variation
 * selector (U+FE0F), the zero-width joiner that glues 👩+💻 into 👩‍💻 (U+200D), the keycap mark
 * (U+20E3) and the five skin-tone modifiers. */
function isEmojiModifier(codePoint: number): boolean {
  return (
    codePoint === 0xfe0f ||
    codePoint === 0x200d ||
    codePoint === 0x20e3 ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
  );
}

/**
 * If an emoji cluster starts at `start`, returns it and the index just past it; `null` otherwise.
 *
 * `chars` is the text as an array of **code points**, not UTF-16 units — see the note on
 * {@link splitTextEmojis}. The rules, in order:
 *
 *  - a digit, `#` or `*` is only an emoji as a keycap: it must be followed by (optionally U+FE0F
 *    and then) the combining keycap mark, as in 1️⃣;
 *  - otherwise the first character must be an emoji base;
 *  - the cluster then extends over any run of modifiers, and over another base character whenever
 *    the previous one was a zero-width joiner — which is how 👨‍👩‍👧 stays one cluster.
 */
function emojiClusterAt(
  chars: readonly string[],
  start: number,
): { cluster: string; end: number } | null {
  const first = chars[start] ?? "";
  const firstCodePoint = first.codePointAt(0) ?? -1;
  let end = start + 1;

  if ("0123456789#*".includes(first)) {
    let maybeEnd = end;
    if (maybeEnd < chars.length && chars[maybeEnd]?.codePointAt(0) === 0xfe0f) maybeEnd += 1;
    if (maybeEnd < chars.length && chars[maybeEnd]?.codePointAt(0) === 0x20e3) {
      return { cluster: chars.slice(start, maybeEnd + 1).join(""), end: maybeEnd + 1 };
    }
    return null;
  }

  if (!isEmojiBase(firstCodePoint)) return null;

  // A flag is two regional indicators side by side with no joiner between them — 🇺🇸 is
  // U+1F1FA U+1F1F8 and nothing else. Pair them here, before the modifier loop, which would
  // otherwise stop after the first indicator and split the flag into two letter tiles.
  if (isRegionalIndicator(firstCodePoint)) {
    const next = chars[end]?.codePointAt(0) ?? -1;
    if (isRegionalIndicator(next)) end += 1;
    return { cluster: chars.slice(start, end).join(""), end };
  }

  while (end < chars.length) {
    const codePoint = chars[end]?.codePointAt(0) ?? -1;
    if (isEmojiModifier(codePoint)) {
      end += 1;
      continue;
    }
    if (chars[end - 1]?.codePointAt(0) === 0x200d && isEmojiBase(codePoint)) {
      end += 1;
      continue;
    }
    break;
  }
  return { cluster: chars.slice(start, end).join(""), end };
}

/** The Twemoji image URL for one emoji cluster: the code points in hex, joined with dashes.
 * U+FE0F variation selectors are dropped, but only from clusters with no zero-width joiner —
 * that is Twemoji's own file-naming rule (its `grabTheRightIcon`): ❤️ is `2764.png`, yet the
 * heart-on-fire sequence ❤️‍🔥 keeps its selector as `2764-fe0f-200d-1f525.png`. */
function twemojiUrl(cluster: string): string {
  const keepVariationSelectors = cluster.includes("\u200d");
  const codePoints: string[] = [];
  for (const char of cluster) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint !== 0xfe0f || keepVariationSelectors) codePoints.push(codePoint.toString(16));
  }
  return `${TWEMOJI_BASE}/${codePoints.join("-")}.png`;
}

/** Appends text to `parts`, merging into a trailing text part rather than growing the array —
 * so "a🎉b" becomes three parts, not "a", image, "", "b". */
function appendTextPart(parts: ChatPart[], text: string): void {
  if (text === "") return;
  const last = parts[parts.length - 1];
  if (last !== undefined && last.type === "text") {
    last.text += text;
    return;
  }
  parts.push({ type: "text", text });
}

/**
 * Splits a text run into text parts and Twemoji image parts.
 *
 * The text is first spread into an array of code points (`Array.from` iterates by code point, not
 * by UTF-16 unit), because every emoji base character lives outside the Basic Multilingual Plane
 * and JavaScript string indexing would land in the middle of its surrogate pair. Working on code
 * points makes this a faithful port of the Python original, whose strings are code-point-indexed
 * by nature.
 */
function splitTextEmojis(text: string): ChatPart[] {
  const chars = Array.from(text);
  const parts: ChatPart[] = [];
  let textStart = 0;
  let index = 0;

  while (index < chars.length) {
    const found = emojiClusterAt(chars, index);
    if (found === null) {
      index += 1;
      continue;
    }
    appendTextPart(parts, chars.slice(textStart, index).join(""));
    parts.push({ type: "image", name: found.cluster, url: twemojiUrl(found.cluster) });
    index = found.end;
    textStart = found.end;
  }

  appendTextPart(parts, chars.slice(textStart).join(""));
  return parts;
}

/**
 * Returns `message` with Unicode emoji in its text parts replaced by Twemoji image parts.
 *
 * Twitch-emote image parts pass through untouched — the backend already resolved those. A message
 * whose backend somehow sent no parts at all falls back to treating its `text` as one text run, so
 * an overlay never has to handle "text but no parts". When nothing needed splitting, the original
 * object is returned unchanged, which keeps the common no-emoji message allocation-free.
 */
function withTwemoji(message: ChatMessage): ChatMessage {
  const source: ChatPart[] =
    message.parts.length > 0
      ? message.parts
      : message.text !== ""
        ? [{ type: "text", text: message.text }]
        : [];

  const parts: ChatPart[] = [];
  let changed = message.parts.length === 0 && source.length > 0;
  for (const part of source) {
    if (part.type !== "text") {
      parts.push(part);
      continue;
    }
    const split = splitTextEmojis(part.text);
    if (split.length === 1 && split[0]?.type === "text") {
      appendTextPart(parts, part.text);
      continue;
    }
    changed = true;
    for (const piece of split) {
      if (piece.type === "text") appendTextPart(parts, piece.text);
      else parts.push(piece);
    }
  }

  if (!changed) return message;
  return { ...message, parts };
}

/* ------------------------------------------------------------------ */
/* The simulated feed                                                  */
/* ------------------------------------------------------------------ */

/** The cast of the simulated chat. Colours and seeds are fixed literals rather than computed,
 * because the point of `seed` is per-user stability and a literal cannot drift. */
const SIMULATED_USERS = [
  { username: "pixel_pal", displayName: "Pixel_Pal", color: "#7fdbca", seed: 0x51c07f },
  { username: "night_owl", displayName: "night_owl", color: "#c792ea", seed: 0x2b90c7 },
  { username: "gg_marta", displayName: "GG_Marta", color: "#ffcb6b", seed: 0x9a41ff },
  { username: "lurker_len", displayName: "lurker_len", color: "#82aaff", seed: 0x1f6682 },
  { username: "chatterbox", displayName: "ChatterBox", color: "#f78c6c", seed: 0x74d2f7 },
] as const;

/** Deliberately emote-free, so the simulated feed exercises no image loading at all. */
const SIMULATED_LINES = [
  "hello chat",
  "that transition was clean",
  "what game is this again?",
  "the overlay looks great tonight",
  "gg",
  "did anyone clip that?",
  "first time here, this is cosy",
  "song name?",
  "lol",
  "nice save",
  "brb getting coffee",
  "the new scene is so smooth",
] as const;

/* ------------------------------------------------------------------ */
/* The feed                                                            */
/* ------------------------------------------------------------------ */

/**
 * Opens the page's chat feed: one WebSocket on the public chat endpoint, with its own reconnect.
 *
 * Never rejects. A stream that cannot be opened is indistinguishable, to every consumer, from one
 * that is open on an unconfigured backend — both end in the simulated feed.
 */
function createFeed(): ChatFeed {
  /** The message ring `recent()` reads. Replaced wholesale when a snapshot arrives. */
  let ring: ChatMessage[] = [];
  const listeners = new Set<(message: ChatMessage) => void>();

  /** `performance.now()` of the last frame of any kind — message, heartbeat, status, snapshot. */
  let lastFrameAt = -1;
  let lastStatus: TwitchConnectionStatus | null = null;

  let socket: WebSocket | null = null;
  /** When the current socket started connecting, for the stuck-handshake guard. */
  let connectStartedAt = 0;
  let reconnectDelayMs = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending "this connection is healthy, earn the fast retry back" timer. See the open handler. */
  let backoffResetTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  /* Counters for the debug probe only. */
  let messagesSeen = 0;
  let reconnects = 0;
  let simulatedEmitted = 0;

  /** Whether the live stream is currently trustworthy. Evaluated fresh on every read, because
   * both halves — the socket's state and the frame clock — move on their own. */
  const fresh = (): boolean =>
    socket !== null &&
    socket.readyState === WebSocket.OPEN &&
    lastFrameAt >= 0 &&
    performance.now() - lastFrameAt < STALE_AFTER_MS;

  const dispatch = (message: ChatMessage): void => {
    for (const listener of listeners) {
      try {
        listener(message);
      } catch (error) {
        // One effect's broken listener must not silence chat for every other effect on the page.
        console.error("[sdk] A chat listener threw. Continuing with the rest.", error);
      }
    }
  };

  const push = (message: ChatMessage): void => {
    ring.push(message);
    if (ring.length > RECENT_LIMIT) ring.splice(0, ring.length - RECENT_LIMIT);
    dispatch(message);
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
    // Double for next time, up to the cap. Only a connection that stays open long enough
    // (see BACKOFF_RESET_AFTER_MS) resets it to the minimum.
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  };

  const handleFrame = (raw: string): void => {
    lastFrameAt = performance.now();
    let frame: ChatWsFrame;
    try {
      frame = JSON.parse(raw) as ChatWsFrame;
    } catch {
      // A malformed frame is not worth a reconnect: it still proves the stream is alive, which
      // the timestamp above already recorded, and the next frame is independent of this one.
      return;
    }
    switch (frame.type) {
      case "snapshot":
        /*
         * The snapshot *replaces* the ring rather than appending to it. That is what flushes any
         * simulated messages accumulated while disconnected — real history has arrived, and a feed
         * that mixed canned lines into it would be quietly lying. Snapshot messages are not
         * dispatched to listeners: they are backlog, and `recent()` is the API for backlog.
         */
        ring = frame.messages.slice(-RECENT_LIMIT).map(withTwemoji);
        break;
      case "message":
        messagesSeen += 1;
        push(withTwemoji(frame.message));
        break;
      case "status":
        lastStatus = frame.status;
        break;
      case "heartbeat":
        // Its entire job was done by the timestamp update above.
        break;
    }
  };

  function connect(): void {
    if (closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(chatWsUrl());
    } catch {
      // Constructing a WebSocket throws synchronously for a malformed URL. Retry anyway — the
      // backoff makes it cheap, and the simulated feed covers the meantime.
      scheduleReconnect();
      return;
    }
    socket = ws;
    connectStartedAt = performance.now();

    ws.addEventListener("open", () => {
      lastFrameAt = performance.now();
      // A connection earns the fast retry back only by *staying* open for a while. Resetting at
      // `open` itself would defeat the backoff against a proxy that accepts the handshake and
      // closes at once — every cycle would pass through `open` and retry at the minimum forever.
      if (backoffResetTimer !== null) clearTimeout(backoffResetTimer);
      backoffResetTimer = setTimeout(() => {
        backoffResetTimer = null;
        if (socket === ws && ws.readyState === WebSocket.OPEN) {
          reconnectDelayMs = RECONNECT_MIN_MS;
        }
      }, BACKOFF_RESET_AFTER_MS);
    });
    ws.addEventListener("message", (event: MessageEvent<string>) => {
      handleFrame(event.data);
    });
    ws.addEventListener("close", () => {
      // Guard on identity: a stale socket's close event, arriving after a replacement was already
      // made, must not tear down or reconnect over the newer one.
      if (socket !== ws) return;
      socket = null;
      if (!closed) {
        reconnects += 1;
        scheduleReconnect();
      }
    });
    // No "error" handler: the specification guarantees a close event follows every error, and the
    // close handler above is the one that acts. The error event carries no detail anyway.
  }

  connect();

  /*
   * The staleness watchdog. `onclose` only fires when the browser *knows* the connection died; a
   * dead network path (unplugged cable, suspended laptop) leaves the socket claiming OPEN forever.
   * Closing it here routes that case through the ordinary close-then-reconnect path, so there is
   * exactly one recovery mechanism. The same sweep abandons a handshake that has hung in
   * CONNECTING past its budget — closing a connecting socket also fires the close event.
   */
  const watchdog = setInterval(() => {
    const ws = socket;
    if (ws === null) return;
    const now = performance.now();
    if (
      ws.readyState === WebSocket.OPEN &&
      lastFrameAt >= 0 &&
      now - lastFrameAt > STALE_AFTER_MS
    ) {
      ws.close();
    } else if (
      ws.readyState === WebSocket.CONNECTING &&
      now - connectStartedAt > CONNECT_TIMEOUT_MS
    ) {
      ws.close();
    }
  }, 1_000);

  /*
   * The simulated feed. The timer chain runs for the life of the page and decides *at each tick*
   * whether to emit, rather than being started and stopped on connection changes — two moving
   * parts (a timer and a state machine driving it) collapse into one, and a race between "stream
   * went stale" and "timer was cancelled" cannot exist.
   */
  let simSeq = 0;
  let simTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSimulated = (): void => {
    if (closed) return;
    const gap =
      SIMULATED_MIN_GAP_MS + Math.random() * (SIMULATED_MAX_GAP_MS - SIMULATED_MIN_GAP_MS);
    simTimer = setTimeout(() => {
      if (closed) return;
      if (!fresh()) {
        simSeq += 1;
        simulatedEmitted += 1;
        // Rotate through the cast in order (stable identity), pick the line at random (variety).
        const user = SIMULATED_USERS[simSeq % SIMULATED_USERS.length] ?? SIMULATED_USERS[0];
        const text =
          SIMULATED_LINES[Math.floor(Math.random() * SIMULATED_LINES.length)] ?? SIMULATED_LINES[0];
        push({
          id: `sim-${simSeq}`,
          at: Date.now(),
          // A channel name no real channel can collide with, so anything inspecting messages can
          // tell canned ones apart even after `bus.source` has flipped back to "live".
          channel: "simulated",
          username: user.username,
          displayName: user.displayName,
          color: user.color,
          seed: user.seed,
          event: "chat",
          text,
          parts: [{ type: "text", text }],
          data: {},
        });
      }
      scheduleSimulated();
    }, gap);
  };
  scheduleSimulated();

  const bus: ChatBus = {
    recent(): ChatMessage[] {
      return ring.slice();
    },
    onMessage(listener: (message: ChatMessage) => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    get source(): ChatBus["source"] {
      return fresh() ? "live" : "simulated";
    },
    status(): TwitchConnectionStatus | null {
      return lastStatus;
    },
  };

  /*
   * Published for the verification harness, exactly like the audio feed's probe: whether the page
   * is showing real chat or the simulation is the distinction that matters and the one a
   * screenshot cannot make. Absent from a production build unless the URL carries `?sdkDebug`.
   */
  publishDebug("chat", () => ({
    source: bus.source,
    // 0 connecting, 1 open, 2 closing, 3 closed; -1 means no socket exists right now.
    readyState: socket?.readyState ?? -1,
    recent: ring.length,
    listeners: listeners.size,
    messagesSeen,
    reconnects,
    reconnectDelayMs,
    simulatedEmitted,
    upstream: lastStatus?.state ?? null,
    millisSinceFrame: lastFrameAt < 0 ? -1 : Math.round(performance.now() - lastFrameAt),
  }));

  return {
    bus,
    close(): void {
      closed = true;
      clearInterval(watchdog);
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (backoffResetTimer !== null) {
        clearTimeout(backoffResetTimer);
        backoffResetTimer = null;
      }
      // The probe's closure holds the whole feed — ring, listeners, socket — so leaving it on
      // `window.__sdkDebug` after destroy would retain a dead feed for the page lifetime and
      // show the harness stale state as if live.
      unpublishDebug("chat");
      if (simTimer !== null) {
        clearTimeout(simTimer);
        simTimer = null;
      }
      socket?.close();
      socket = null;
      listeners.clear();
    },
  };
}

/**
 * The page's single chat feed, refcounted.
 *
 * Exported for the verification harness (`stats()`, `shutdownNow()`). Effects use {@link useChat}.
 */
export const chatResource: SharedResource<ChatFeed> = createSharedResource<ChatFeed>({
  label: "chat",
  create: createFeed,
  destroy(feed: ChatFeed): void {
    feed.close();
  },
});

/**
 * Acquires the page's chat bus for as long as `scope` is alive.
 *
 * ```ts
 * const chat = await useChat(scope);
 * scope.checkpoint();
 * for (const message of chat.recent()) feed.push(message); // seed the backlog
 * const off = chat.onMessage((message) => feed.push(message));
 * scope.defer(off);
 * ```
 *
 * **It never rejects.** No Twitch configuration, a backend that is down, a dropped stream — all of
 * them end with the bus reporting `source: "simulated"` and emitting canned messages, so an effect
 * needs no error handling and no fallback branch of its own. It must still idle gracefully on an
 * *empty* feed, because simulated messages arrive seconds apart, not instantly.
 *
 * **It does not checkpoint for you.** Put a `scope.checkpoint()` on the line after the `await`,
 * exactly as with `useAudio` — the scope can die while the acquire is resolving.
 *
 * The release is registered on `scope`, so there is nothing to remember. The shared resource
 * lingers briefly after its last consumer lets go (see `lease.ts`), so a route change does not
 * close and reopen the WebSocket.
 */
export async function useChat(scope: Scope): Promise<ChatBus> {
  const lease = await chatResource.acquire(scope);
  return lease.value.bus;
}
