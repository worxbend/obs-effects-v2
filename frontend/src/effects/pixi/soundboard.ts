import * as PIXI from "pixi.js";

import { getSoundboard, soundAudioUrl } from "~/api/client";
import type { ChatMessage } from "~/types/contract";
import { bool, colorInt, int, num } from "../paramUtils";
import {
  compileSoundboard,
  createPixiStage,
  defineEffect,
  firstMatch,
  onFrame,
  useChat,
} from "../sdk";
import type { PreparedRule } from "../sdk";

/**
 * Soundboard
 * ==========
 *
 * Plays admin-configured sounds when chat says the right thing. The rules live on the server
 * (`GET /api/soundboard`, edited on the Settings page): each one maps a *condition tree* — nested
 * And/Or groups of tests like "first word is !drum", "contains hype", "has any emote", "event is
 * raid", "sender is worxbend" — to a stored sound by name. When a rule fires, the matched
 * sound plays and the message's emotes and emoji burst upward from the bottom of the frame,
 * twitch-vizer style — sprites float up with a wobble and fade out. A message with no images
 * bursts a spray of accent-coloured circles instead, so a firing rule is always visible.
 *
 * ## Matching
 *
 * All evaluation lives in the shared, pure evaluator in `../sdk/soundboard.ts` — the Settings
 * page's live test box imports the same functions, so what it previews is what this effect plays.
 * The semantics themselves are specified in `docs/CONTRACT.md` §2.10. Rules are evaluated in
 * stored order over enabled rules only; the first match wins. Non-chat events
 * (sub/cheer/raid/gift_sub) are matched too — on their `text`, their event kind, or anything else
 * a condition tests.
 *
 * ## Audio, borrowed from `chat-sound.ts`
 *
 * One reused `HTMLAudioElement`, one playback at a time, a bounded queue, and silent failure — see
 * that file's header for why each of those matters on a long-running OBS source. The one addition
 * here is a **per-rule cooldown**: chat spamming "!drum" fires the drum once per cooldown window,
 * while a different rule can still fire in between. Cooldowns are keyed by the rule's server id,
 * which is stable across edits, so re-saving the soundboard does not reset them spuriously.
 *
 * ## Rules refresh without a remount
 *
 * The soundboard is fetched at setup and re-fetched every 60 seconds on a scope-owned timer, so an
 * edit on the Settings page reaches a running overlay within a minute. Condition trees (and the
 * regexes inside them) are compiled once per fetch, not once per message, by the shared
 * `compileSoundboard`. A fetch that fails keeps the previous rules — a backend blip must not turn
 * the soundboard off.
 */

/** How often the rule list is re-read from the server, in milliseconds. */
const REFRESH_MS = 60_000;

/** How long one burst sprite lives, in seconds, from spawn to fully faded. */
const BURST_SECONDS = 2.6;

/** One floating burst sprite (an emote image or an accent circle) and its motion constants. */
interface BurstParticle {
  view: PIXI.Container;
  /** Seconds since spawn. */
  age: number;
  x: number;
  y: number;
  /** Upward speed in pixels per second. */
  rise: number;
  /** Horizontal wobble amplitude in pixels and its phase/frequency. */
  wobble: number;
  phase: number;
  frequency: number;
  /** Rotation speed in radians per second. */
  spin: number;
}

const soundboard = defineEffect({
  descriptor: {
    id: "soundboard",
    name: "Soundboard",
    description:
      "Chat-triggered sounds: admin-configured rules match messages with nested And/Or conditions (commands, text, regexes, emotes, emoji, events, senders) and play a stored clip, and each hit bursts the message's emotes upward from the bottom of the frame.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "audio", "sound", "soundboard", "emotes"],
    previewNotes:
      "Rules are edited on the Settings page under Soundboard; a running overlay picks up changes within a minute. The audio plays unprompted in OBS, but a normal browser tab may keep it silent until you click the page once. Simulated chat messages match rules but stay silent unless Play Simulated Chat is on — the emote burst still shows, so a preview proves the matching works. Transparent apart from the bursts.",
    params: [
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
        default: 2,
        min: 0,
        max: 60,
        step: 0.5,
        description:
          "Minimum gap between two firings of the same rule. Chat spamming one command plays its sound once per window; a different rule can still fire in between.",
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
          "How many sounds may wait while one is playing. Firings beyond it are dropped — a raid should trigger a few sounds, not one per message.",
      },
      {
        key: "playSimulated",
        label: "Play Simulated Chat",
        kind: "boolean",
        default: false,
        description:
          "Also play sounds for the canned messages shown when no Twitch chat is connected. Off by default so a disconnected overlay stays silent on air — the visual burst still shows either way.",
      },
      {
        key: "showVisuals",
        label: "Show Visuals",
        kind: "boolean",
        default: true,
        description:
          "Burst the message's emotes (or accent circles) when a rule fires. Off makes the effect purely audible.",
      },
      {
        key: "burstCount",
        label: "Burst Size",
        kind: "number",
        default: 8,
        min: 1,
        max: 30,
        step: 1,
        description: "How many sprites one firing spawns.",
      },
      {
        key: "spriteSize",
        label: "Sprite Size",
        kind: "number",
        default: 56,
        min: 16,
        max: 160,
        step: 4,
        description: "Size of each burst sprite, in pixels.",
      },
      {
        key: "accentColor",
        label: "Accent Colour",
        kind: "color",
        default: "#9146ff",
        description:
          "Colour of the fallback circles, used when the matched message carries no emotes or emoji.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    const chat = await useChat(scope);
    scope.checkpoint();

    let volume = num(ctx.params, "volume", 0.8, 0, 1);
    let cooldownSeconds = num(ctx.params, "cooldownSeconds", 2, 0, 60);
    let maxQueue = int(ctx.params, "maxQueue", 3, 0, 20);
    let playSimulated = bool(ctx.params, "playSimulated", false);
    let showVisuals = bool(ctx.params, "showVisuals", true);
    let burstCount = int(ctx.params, "burstCount", 8, 1, 30);
    let spriteSize = int(ctx.params, "spriteSize", 56, 16, 160);
    let accentColor = colorInt(ctx.params, "accentColor", "#9146ff");

    /* ---------------- Rules: fetch now, re-fetch every minute ---------------- */

    let compiled: PreparedRule[] = [];

    const refreshRules = (): void => {
      void getSoundboard()
        .then((board) => {
          if (scope.disposed) return;
          compiled = compileSoundboard(board);
        })
        .catch(() => {
          // Keep the rules from the last successful fetch. A backend blip must not silently
          // switch the soundboard off; the next tick tries again anyway.
        });
    };
    refreshRules();
    const refreshTimer = setInterval(refreshRules, REFRESH_MS);
    scope.defer(() => clearInterval(refreshTimer));

    /* ---------------- Audio: the chat-sound queue, with sound names ---------------- */

    /*
     * The one audio element the whole effect plays through — see chat-sound.ts for why one reused
     * element beats one per clip on a long-running OBS source. Unlike chat-sound's payload-free
     * counter, the queue here holds the *names* of the sounds to play, because different rules
     * play different clips and order matters.
     */
    const audio = new Audio();
    audio.preload = "auto";
    scope.defer(() => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    });

    const queue: string[] = [];
    let playing = false;
    let time = 0;

    /** Effect-clock time each rule last fired, keyed by the rule's stable server id. */
    const lastFiredAt = new Map<string, number>();

    /* Counters for anyone debugging why a sound did or did not play. Never shown on air. */
    let played = 0;
    let dropped = 0;
    let failed = 0;

    const finishPlayback = (): void => {
      playing = false;
    };

    const startPlayback = (soundName: string): void => {
      audio.src = soundAudioUrl(soundName);
      audio.volume = volume;
      audio.currentTime = 0;
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
        // Autoplay refusal (a normal tab before any click), a missing sound name, a codec the
        // browser lacks. Either way the overlay carries on; the counter is the only trace.
        failed += 1;
        finishPlayback();
      });
    };

    /* ---------------- Visuals: the emote burst ---------------- */

    const particles: BurstParticle[] = [];

    /** Texture cache, keyed by URL, shared across bursts so a spammed emote loads once. A failed
     * load is cached as `null` so the URL is not retried on every message. */
    const textures = new Map<string, PIXI.Texture | null>();

    const loadTexture = async (url: string): Promise<PIXI.Texture | null> => {
      const cached = textures.get(url);
      if (cached !== undefined) return cached;
      try {
        const texture = await PIXI.Assets.load<PIXI.Texture>(url);
        textures.set(url, texture);
        return texture;
      } catch {
        // A dead emote CDN URL must not throw on a live overlay; the accent circle covers for it.
        textures.set(url, null);
        return null;
      }
    };

    /** A filled accent circle with a soft white highlight — the burst when there is no image. */
    const makeCircle = (size: number): PIXI.Container => {
      const g = new PIXI.Graphics();
      const r = size / 2;
      g.circle(0, 0, r).fill(accentColor);
      g.circle(-r * 0.3, -r * 0.3, r * 0.32).fill({ color: 0xffffff, alpha: 0.35 });
      return g;
    };

    const spawnParticle = (view: PIXI.Container): void => {
      const particle: BurstParticle = {
        view,
        age: 0,
        x: 40 + Math.random() * Math.max(1, stage.width - 80),
        y: stage.height + spriteSize,
        rise: (stage.height / BURST_SECONDS) * (0.55 + Math.random() * 0.5),
        wobble: 14 + Math.random() * 26,
        phase: Math.random() * Math.PI * 2,
        frequency: 2 + Math.random() * 3,
        spin: (Math.random() - 0.5) * 1.6,
      };
      particles.push(particle);
      stage.stage.addChild(view);
    };

    /** Bursts the message's image parts (emotes and Twemoji) upward, or accent circles when the
     * message carries none. Textures load asynchronously; a sprite whose image never arrives is
     * simply replaced by a circle, so the burst count is honoured either way. */
    const burst = (msg: ChatMessage): void => {
      if (!showVisuals) return;
      const images = msg.parts.filter((part) => part.type === "image");
      for (let i = 0; i < burstCount; i++) {
        if (images.length === 0) {
          spawnParticle(makeCircle(spriteSize));
          continue;
        }
        const part = images[i % images.length];
        if (part === undefined) continue;
        const holder = new PIXI.Container();
        spawnParticle(holder);
        void loadTexture(part.url).then((texture) => {
          if (holder.destroyed) return;
          if (texture === null) {
            holder.addChild(makeCircle(spriteSize));
            return;
          }
          const sprite = new PIXI.Sprite(texture);
          const scale = spriteSize / Math.max(sprite.width, sprite.height, 1);
          sprite.scale.set(scale);
          sprite.anchor.set(0.5);
          holder.addChild(sprite);
        });
      }
    };

    /* ---------------- Wiring chat to the two outputs ---------------- */

    const off = chat.onMessage((message) => {
      const rule = firstMatch(compiled, message);
      if (rule === null) return;

      // Per-rule cooldown, keyed by the stable server id: the same rule fires at most once per
      // window, while a different rule remains free to fire in between.
      const last = lastFiredAt.get(rule.id);
      if (last !== undefined && time - last < cooldownSeconds) return;
      lastFiredAt.set(rule.id, time);

      // The visual burst always shows — in a preview it is the proof that matching works. The
      // sound is what stays quiet for canned messages: their impossible channel name survives
      // even after `chat.source` has flipped back to "live", so a stale fake cannot play.
      burst(message);
      if (!playSimulated && (chat.source === "simulated" || message.channel === "simulated")) {
        return;
      }
      // The queue limit is a cap on *waiting* sounds, so it only applies while one is playing:
      // an idle soundboard always accepts a firing (with maxQueue 0 the firing goes straight
      // through the queue to the frame loop, which drains it before another can pile up).
      if (playing && queue.length >= maxQueue) {
        dropped += 1;
        return;
      }
      queue.push(rule.sound);
    });
    scope.defer(off);

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += dt;

      // Playback is started from the frame loop rather than from the message handler, so the
      // queue has one clock and one place that reads it — a handler racing `onended` cannot
      // start two clips at once.
      if (!playing && queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) {
          playing = true;
          startPlayback(next);
        }
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const particle = particles[i];
        if (particle === undefined) continue;
        particle.age += dt;
        const progress = particle.age / BURST_SECONDS;
        if (progress >= 1 || particle.y < -spriteSize) {
          particle.view.destroy({ children: true });
          particles.splice(i, 1);
          continue;
        }
        particle.y -= particle.rise * dt;
        particle.view.x =
          particle.x + Math.sin(particle.age * particle.frequency + particle.phase) * particle.wobble;
        particle.view.y = particle.y;
        particle.view.rotation += particle.spin * dt;
        // Pop in over the first tenth of the lifetime, fade out over the last half.
        const enter = Math.min(1, progress * 10);
        const leave = progress > 0.5 ? 1 - (progress - 0.5) * 2 : 1;
        particle.view.alpha = enter * leave;
      }

      stage.render();
    });

    // The frame loop above never removes particles' textures from the cache: emotes repeat, and
    // Pixi's Assets cache holds them anyway. The scope tears the stage (and every sprite) down.

    // Referenced so the counters demonstrably exist for a debugger's breakpoint; they carry no
    // rendering weight and are the effect's only record of dropped or failed playbacks.
    void played;
    void dropped;
    void failed;

    return {
      setParams(p: Record<string, unknown>): void {
        volume = num(p, "volume", 0.8, 0, 1);
        cooldownSeconds = num(p, "cooldownSeconds", 2, 0, 60);
        maxQueue = int(p, "maxQueue", 3, 0, 20);
        playSimulated = bool(p, "playSimulated", false);
        showVisuals = bool(p, "showVisuals", true);
        burstCount = int(p, "burstCount", 8, 1, 30);
        spriteSize = int(p, "spriteSize", 56, 16, 160);
        accentColor = colorInt(p, "accentColor", "#9146ff");
        // Volume applies to the clip already playing, not only the next one.
        audio.volume = volume;
      },
    };
  },
});

export default soundboard;
