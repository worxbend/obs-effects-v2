import * as PIXI from "pixi.js";

import { soundAudioUrl } from "~/api/client";
import { bool, colorHex, int, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";

/**
 * Chat Sound
 * ==========
 *
 * Plays a notification sound for every chat message, the way Discord or Slack pings when someone
 * speaks. The audio is the point; the visual is a deliberately small speaker glyph that pulses a
 * ring outward on each playback, and even that can be switched off.
 *
 * Ported in spirit from the OBS page of the `twitch-voxer` project, whose queue discipline is the
 * part worth keeping:
 *
 *  - **One playback at a time.** Messages arriving mid-playback queue up and play back to back,
 *    rather than layering into a mush of overlapping pings.
 *  - **The queue is bounded.** A raid dropping fifty messages in two seconds must not commit the
 *    overlay to fifty sequential pings — arrivals beyond the cap are dropped, newest first,
 *    because a ping's value is "something happened", not an exact count.
 *  - **A cooldown between pings.** Even sequential playback of short clips is grating at chat
 *    speed; a minimum gap keeps the sound an accent instead of a metronome.
 *
 * Where voxer created a fresh `Audio` element per clip, this effect reuses **one** element and
 * swaps its `src`. A long-running OBS source that allocated an element per message would leak
 * media resources; one element makes the lifecycle trivial to own — the scope pauses it and clears
 * its `src` on dispose, and nothing else ever holds it.
 *
 * Failures are silent by design. A missing sound, a codec the browser lacks, a blocked autoplay —
 * none of them may throw on a live overlay. Each failed playback bumps a debug counter and the
 * queue moves on.
 */

/** How long the pulse ring takes to expand and fade, in seconds. */
const PULSE_SECONDS = 0.9;

const chatSound = defineEffect({
  descriptor: {
    id: "chat-sound",
    name: "Chat Sound",
    description:
      "Plays a notification sound for each chat message — Discord-style ping, Slack-style knock, or any uploaded clip — with a small speaker glyph that pulses on playback.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "audio", "sound", "notification"],
    previewNotes:
      "The audio is the effect. In OBS it plays unprompted — the browser source has no autoplay restriction — but a normal browser tab may keep it silent until you click the page once. Custom clips are uploaded on the Settings page under Sounds. Transparent apart from the small indicator, which Show Indicator can hide entirely.",
    params: [
      {
        key: "soundMode",
        label: "Sound",
        kind: "select",
        default: "discord",
        options: ["discord", "slack-message", "custom"],
        description:
          "Which clip to play. The first two always exist on the server; \"custom\" plays the sound named below.",
      },
      {
        key: "customSound",
        label: "Custom Sound",
        kind: "text",
        default: "",
        description:
          "The name (or id) of an uploaded sound, from the Settings page. Only used when Sound is \"custom\".",
      },
      {
        key: "volume",
        label: "Volume",
        kind: "number",
        default: 0.8,
        min: 0,
        max: 1,
        step: 0.05,
        description: "Playback volume. 0 mutes without unloading anything.",
      },
      {
        key: "cooldownSeconds",
        label: "Cooldown",
        kind: "number",
        default: 1,
        min: 0,
        max: 30,
        step: 0.5,
        description:
          "Minimum gap between the start of one ping and the start of the next. Messages arriving inside it queue up rather than being lost.",
      },
      {
        key: "maxQueue",
        label: "Queue Limit",
        kind: "number",
        default: 3,
        min: 0,
        max: 20,
        step: 1,
        description:
          "How many pings may wait while one is playing. Arrivals beyond it are dropped — a raid should ping a few times, not once per message.",
      },
      {
        key: "playSimulated",
        label: "Play Simulated Chat",
        kind: "boolean",
        default: false,
        description:
          "Also ping for the canned messages shown when no Twitch chat is connected. Off by default so a disconnected overlay stays silent on air.",
      },
      {
        key: "showIndicator",
        label: "Show Indicator",
        kind: "boolean",
        default: true,
        description: "Draw the speaker glyph and pulse ring. Off makes the effect purely audible.",
      },
      {
        key: "indicatorColor",
        label: "Indicator Colour",
        kind: "color",
        default: "#7fdbca",
        description: "Colour of the glyph and the pulse ring.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    const chat = await useChat(scope);
    scope.checkpoint();

    let soundMode = str(ctx.params, "soundMode", "discord");
    let customSound = str(ctx.params, "customSound", "");
    let volume = num(ctx.params, "volume", 0.8, 0, 1);
    let cooldownSeconds = num(ctx.params, "cooldownSeconds", 1, 0, 30);
    let maxQueue = int(ctx.params, "maxQueue", 3, 0, 20);
    let playSimulated = bool(ctx.params, "playSimulated", false);
    let showIndicator = bool(ctx.params, "showIndicator", true);
    let indicatorColor = colorHex(ctx.params, "indicatorColor", "#7fdbca");

    /** Which clip to fetch right now. Empty means "nothing configured", which plays nothing. */
    const currentSoundKey = (): string =>
      soundMode === "custom" ? customSound.trim() : soundMode;

    /*
     * The one audio element the whole effect plays through, exactly one for the effect's lifetime.
     * The scope owns its teardown: pausing stops any in-flight playback, and clearing `src` (with
     * a `load()` to make the browser act on it) releases the decoder and any buffered bytes, so a
     * route change does not leave a detached element playing into the stream.
     */
    const audio = new Audio();
    audio.preload = "auto";
    scope.defer(() => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    });

    /*
     * The queue holds nothing per message — a ping carries no payload — so it is a plain counter.
     * That is also what makes "drop when full" free of ordering questions: there is no newest or
     * oldest entry to argue about, only a count that stops rising.
     */
    let pending = 0;
    let playing = false;
    /** Effect-clock time before which the next playback may not start. */
    let cooldownUntil = 0;
    let time = 0;

    /* Counters for anyone debugging why a ping did or did not sound. Never shown on air. */
    let played = 0;
    let dropped = 0;
    let failed = 0;

    /** Seconds since the current pulse started, or a value past PULSE_SECONDS when idle. */
    let pulseAge = PULSE_SECONDS;

    const finishPlayback = (): void => {
      playing = false;
    };

    const startPlayback = (): void => {
      const key = currentSoundKey();
      if (key === "") {
        // "custom" with no name configured. Consume the ping silently rather than erroring —
        // an operator mid-configuration should see a quiet overlay, not a broken one.
        finishPlayback();
        return;
      }
      audio.src = soundAudioUrl(key);
      audio.volume = volume;
      audio.currentTime = 0;
      pulseAge = 0;
      // `onended`/`onerror` assignment (not addEventListener) so a replayed element never
      // accumulates handlers: each playback overwrites the previous playback's pair.
      audio.onended = () => {
        played += 1;
        finishPlayback();
      };
      audio.onerror = () => {
        failed += 1;
        finishPlayback();
      };
      audio.play().catch(() => {
        // Autoplay refusal (a normal tab before any click) or a fetch failure. Either way the
        // overlay carries on; the counter is the only trace.
        failed += 1;
        finishPlayback();
      });
    };

    const off = chat.onMessage((message) => {
      // Canned messages are marked by their impossible channel name, which survives even after
      // `chat.source` has flipped back to "live" — so this filter cannot ping for a stale fake.
      if (!playSimulated && (chat.source === "simulated" || message.channel === "simulated")) {
        return;
      }
      if (pending >= maxQueue) {
        dropped += 1;
        return;
      }
      pending += 1;
    });
    scope.defer(off);

    const glyph = stage.stage.addChild(new PIXI.Graphics());
    const ring = stage.stage.addChild(new PIXI.Graphics());

    /** A small procedural speaker: body, cone, and two arcs for the sound waves. No assets. */
    const drawGlyph = (alpha: number): void => {
      glyph.clear();
      if (!showIndicator) return;
      const cx = stage.width - 48;
      const cy = stage.height - 48;
      glyph
        .rect(cx - 14, cy - 6, 8, 12)
        .fill({ color: indicatorColor, alpha })
        .poly([cx - 6, cy - 6, cx + 4, cy - 14, cx + 4, cy + 14, cx - 6, cy + 6])
        .fill({ color: indicatorColor, alpha });
      glyph
        .arc(cx + 8, cy, 8, -Math.PI / 3, Math.PI / 3)
        .stroke({ color: indicatorColor, alpha, width: 2 });
      glyph
        .arc(cx + 8, cy, 13, -Math.PI / 3, Math.PI / 3)
        .stroke({ color: indicatorColor, alpha: alpha * 0.6, width: 2 });
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += dt;
      pulseAge += dt;

      // Playback is started from the frame loop rather than from the message handler, so the
      // cooldown has one clock and one place that reads it — a handler racing a timer cannot
      // start two clips at once.
      if (!playing && pending > 0 && time >= cooldownUntil) {
        pending -= 1;
        playing = true;
        cooldownUntil = time + cooldownSeconds;
        startPlayback();
      }

      // The glyph sits dim while idle and brightens while a clip is playing; the ring expands
      // outward once per playback and fades as it grows.
      drawGlyph(playing ? 0.9 : 0.35);
      ring.clear();
      if (showIndicator && pulseAge < PULSE_SECONDS) {
        const p = pulseAge / PULSE_SECONDS;
        ring
          .circle(stage.width - 48, stage.height - 48, 10 + p * 34)
          .stroke({ color: indicatorColor, alpha: (1 - p) * 0.8, width: 3 });
      }

      stage.render();
    });

    // Referenced so the counters demonstrably exist for a debugger's breakpoint; they carry no
    // rendering weight and are the effect's only record of dropped or failed pings.
    void played;
    void dropped;
    void failed;

    return {
      setParams(p: Record<string, unknown>): void {
        soundMode = str(p, "soundMode", "discord");
        customSound = str(p, "customSound", "");
        volume = num(p, "volume", 0.8, 0, 1);
        cooldownSeconds = num(p, "cooldownSeconds", 1, 0, 30);
        maxQueue = int(p, "maxQueue", 3, 0, 20);
        playSimulated = bool(p, "playSimulated", false);
        showIndicator = bool(p, "showIndicator", true);
        indicatorColor = colorHex(p, "indicatorColor", "#7fdbca");
        // Volume applies to the clip already playing, not only the next one.
        audio.volume = volume;
      },
    };
  },
});

export default chatSound;
