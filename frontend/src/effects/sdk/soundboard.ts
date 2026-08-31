import type {
  ChatImagePart,
  ChatMessage,
  Soundboard,
  SoundboardCondition,
  SoundboardRule,
} from "~/types/contract";

/**
 * The soundboard condition evaluator — pure functions, no Pixi, no network.
 *
 * The Soundboard *effect* uses this to decide which rule a live chat message fires, and the
 * Settings page's live test box uses the very same functions to preview a rule against a typed
 * message. Sharing one evaluator is the point: what the test box says will match is what the
 * overlay will actually play.
 *
 * A rule's trigger is a recursive condition tree (see the types in `types/contract.ts`):
 * groups combine children with And/Or and may be negated; leaves test one thing about the
 * message — its first word, a substring, a regex, an emote, an emoji, its event kind, or its
 * sender. Regexes are compiled once, here, at {@link compileSoundboard} time — not once per
 * message — and a source this browser's engine rejects (the backend validated with Java's
 * compiler, whose dialect differs at the edges) turns that leaf into a constant `false` with a
 * single `console.warn`, so one bad rule never breaks the overlay.
 */

export type {
  Soundboard,
  SoundboardCondition,
  SoundboardEventValue,
  SoundboardGroupCondition,
  SoundboardGroupOp,
  SoundboardLeafCondition,
  SoundboardLeafType,
  SoundboardRule,
} from "~/types/contract";

/** A compiled condition tree: the message goes in, the verdict comes out. */
type Predicate = (msg: ChatMessage) => boolean;

/** One rule with its condition tree compiled, ready to test messages against. */
export interface PreparedRule {
  rule: SoundboardRule;
  matches: Predicate;
}

/**
 * Whether an inline image part came from a Unicode emoji (rendered as a Twemoji picture) rather
 * than a Twitch emote. The two arrive through the same `parts` array and differ only in origin:
 * the effect SDK's chat bus builds emoji parts with Twemoji CDN URLs, while Twitch emote parts
 * keep Twitch's own CDN URLs — so the URL is the discriminator.
 */
function isEmojiPart(part: ChatImagePart): boolean {
  return part.url.includes("twemoji");
}

/** The message's inline image parts — Twitch emotes and Twemoji-rendered emoji alike. */
function imageParts(msg: ChatMessage): ChatImagePart[] {
  return msg.parts.filter((part): part is ChatImagePart => part.type === "image");
}

/**
 * Compiles one condition node into a predicate. Recursion depth is bounded by the contract's
 * depth limit of 5, so there is no risk of blowing the stack on stored data.
 */
function compileCondition(condition: SoundboardCondition): Predicate {
  switch (condition.type) {
    case "group": {
      const children = condition.children.map(compileCondition);
      const { op, negate } = condition;
      return (msg) => {
        // `negate` applies to the combined result, not to each child. An empty group cannot be
        // stored (validation forbids it), but if one slips through, "and" over nothing is true
        // and "or" over nothing is false — the usual identities.
        const combined =
          op === "and" ? children.every((child) => child(msg)) : children.some((child) => child(msg));
        return negate ? !combined : combined;
      };
    }
    case "command": {
      const wanted = condition.value.toLowerCase();
      return (msg) => {
        const first = msg.text.trim().split(/\s+/, 1)[0] ?? "";
        return first !== "" && first.toLowerCase() === wanted;
      };
    }
    case "contains": {
      const wanted = condition.value.toLowerCase();
      return (msg) => msg.text.toLowerCase().includes(wanted);
    }
    case "regex": {
      let regex: RegExp;
      try {
        regex = new RegExp(condition.value, "iu");
      } catch {
        // Reported once, at compile time — not once per message.
        console.warn(`soundboard: regex did not compile in this browser: ${condition.value}`);
        return () => false;
      }
      return (msg) => regex.test(msg.text);
    }
    case "emote": {
      const wanted = condition.value;
      return (msg) =>
        imageParts(msg).some(
          (part) =>
            !isEmojiPart(part) &&
            // Empty value means "any Twitch emote". Emote names are case-sensitive on Twitch,
            // so the specific comparison is exact.
            (wanted === "" || part.name === wanted),
        );
    }
    case "emoji": {
      const wanted = condition.value;
      return (msg) =>
        imageParts(msg).some(
          (part) => isEmojiPart(part) && (wanted === "" || part.name === wanted),
        );
    }
    case "event": {
      const wanted = condition.value;
      return (msg) => msg.event === wanted;
    }
    case "user": {
      const wanted = condition.value.toLowerCase();
      return (msg) =>
        msg.username.toLowerCase() === wanted || msg.displayName.toLowerCase() === wanted;
    }
  }
}

/**
 * Compiles the *enabled* rules of a soundboard document, in stored order, so matching does no
 * regex construction (and no tree walking beyond plain calls) per message.
 */
export function compileSoundboard(doc: Soundboard): PreparedRule[] {
  return doc.rules
    .filter((rule) => rule.enabled)
    .map((rule) => ({ rule, matches: compileCondition(rule.condition) }));
}

/** Whether one prepared rule matches the message. */
export function matchRule(prepared: PreparedRule, msg: ChatMessage): boolean {
  return prepared.matches(msg);
}

/** The first prepared rule the message matches, or `null`. Stored order; first match wins. */
export function firstMatch(preparedRules: PreparedRule[], msg: ChatMessage): SoundboardRule | null {
  for (const prepared of preparedRules) {
    if (prepared.matches(msg)) return prepared.rule;
  }
  return null;
}
