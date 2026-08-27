package obseffects.infrastructure.twitch

import munit.FunSuite
import obseffects.domain.JsonValue.{JsonNumber, JsonString}
import obseffects.domain.{ChatEventKind, ChatMessage, ChatPart}
import obseffects.infrastructure.twitch.TwitchIrcClient.EmoteSpan

/** Tests for the pure half of the Twitch IRC client: the line parser, the tag unescaping, the emote splitting, and the
  * message builder.
  *
  * As with the OBS client, the connection itself is not tested — that would mostly prove `java.net.http` works. What is
  * worth pinning down is the string handling, because IRC is all edge cases that fail *quietly*: a mis-parsed tag block
  * does not crash anything, it makes every username come out as the raw tag text, or every emote land two characters to
  * the left, and nobody notices until an overlay looks subtly wrong on stream.
  */
class TwitchIrcClientSuite extends FunSuite {

  private val at = 1724800000000L

  private def parsed(line: String): TwitchIrcClient.IrcMessage =
    TwitchIrcClient.parseLine(line).getOrElse(fail(s"expected the line to parse: $line"))

  private def built(line: String): ChatMessage =
    TwitchIrcClient
      .chatMessage(parsed(line), at, fallbackId = "fallback-id")
      .getOrElse(fail(s"expected a chat message from: $line"))

  // -------------------------------------------------------------------------------------------
  // Line parsing
  // -------------------------------------------------------------------------------------------

  test("a full line splits into tags, prefix, command and params, with the trailing text keeping its spaces") {
    val message = parsed("@id=abc;color=#FF0000 :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :hello  world")

    assertEquals(message.tags, Map("id" -> "abc", "color" -> "#FF0000"))
    assertEquals(message.prefix, Some("nick!nick@nick.tmi.twitch.tv"))
    assertEquals(message.command, "PRIVMSG")
    assertEquals(message.params, List("#chan", "hello  world"))
  }

  test("a line with no tags and no prefix still parses") {
    val message = parsed("PING :tmi.twitch.tv")
    assertEquals(message.command, "PING")
    assertEquals(message.params, List("tmi.twitch.tv"))
  }

  test("a tag without a value reads as the empty string, both spellings") {
    val message = parsed("@flag;empty= :nick PRIVMSG #chan :hi")
    assertEquals(message.tags, Map("flag" -> "", "empty" -> ""))
  }

  test("an empty or malformed line is dropped rather than parsed into something") {
    assertEquals(TwitchIrcClient.parseLine(""), None)
    assertEquals(TwitchIrcClient.parseLine("@tags-with-no-command"), None)
  }

  test("tag values are unescaped: \\s space, \\: semicolon, \\\\ backslash, \\r and \\n line endings") {
    assertEquals(TwitchIrcClient.unescapeTagValue("""a\sb\:c\\d\re\nf"""), "a b;c\\d\re\nf")
  }

  test("an unknown escape keeps the character and a trailing lone backslash is dropped") {
    // Both behaviours are what the IRCv3 spec tells clients to do, and Twitch's system-msg values exercise them.
    assertEquals(TwitchIrcClient.unescapeTagValue("""a\xb\"""), "axb")
  }

  // -------------------------------------------------------------------------------------------
  // Emotes
  // -------------------------------------------------------------------------------------------

  test("the emotes tag parses into spans sorted by start position") {
    val spans = TwitchIrcClient.parseEmotes("25:12-16,0-4/1902:6-10")
    assertEquals(
      spans,
      List(EmoteSpan("25", 0, 4), EmoteSpan("1902", 6, 10), EmoteSpan("25", 12, 16))
    )
  }

  test("a malformed range is skipped without losing the well-formed ones") {
    assertEquals(TwitchIrcClient.parseEmotes("25:0-4,zap/junk"), List(EmoteSpan("25", 0, 4)))
  }

  test("message text splits into alternating text and image parts, taking each emote's name from the text") {
    val parts = TwitchIrcClient.messageParts(
      "Kappa hello Kappa",
      List(EmoteSpan("25", 0, 4), EmoteSpan("25", 12, 16))
    )

    assertEquals(
      parts,
      List(
        ChatPart.Image(
          "Kappa",
          "https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0",
          Some("https://static-cdn.jtvnw.net/emoticons/v2/25/animated/dark/3.0")
        ),
        ChatPart.Text(" hello "),
        ChatPart.Image(
          "Kappa",
          "https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0",
          Some("https://static-cdn.jtvnw.net/emoticons/v2/25/animated/dark/3.0")
        )
      )
    )
  }

  test("emote offsets count code points, so an astral emoji before the emote does not shift the slice") {
    // "😂" is one code point but two UTF-16 units; Twitch's `emotes=25:2-6` counts code points, so a naive
    // UTF-16 substring would slice " Kapp" and leave a stray "a" as text.
    val parts = TwitchIrcClient.messageParts("😂 Kappa", List(EmoteSpan("25", 2, 6)))

    assertEquals(
      parts,
      List(
        ChatPart.Text("😂 "),
        ChatPart.Image(
          "Kappa",
          "https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0",
          Some("https://static-cdn.jtvnw.net/emoticons/v2/25/animated/dark/3.0")
        )
      )
    )
  }

  test("a span pointing outside the text degrades to plain text instead of throwing") {
    // The positions are network input; a bad index must cost an emote image, never the connection.
    assertEquals(
      TwitchIrcClient.messageParts("short", List(EmoteSpan("25", 2, 400))),
      List(ChatPart.Text("short"))
    )
  }

  // -------------------------------------------------------------------------------------------
  // PRIVMSG
  // -------------------------------------------------------------------------------------------

  test("a plain chat line becomes a chat event with identity from the tags") {
    val message = built(
      "@id=msg-1;display-name=SomeLogin;color=#8A2BE2 " +
        ":somelogin!somelogin@somelogin.tmi.twitch.tv PRIVMSG #worxbend :hello chat"
    )

    assertEquals(message.id, "msg-1")
    assertEquals(message.at, at)
    assertEquals(message.channel, "worxbend")
    assertEquals(message.username, "somelogin")
    assertEquals(message.displayName, "SomeLogin")
    assertEquals(message.color, "#8A2BE2")
    assertEquals(message.event, ChatEventKind.Chat)
    assertEquals(message.text, "hello chat")
    assertEquals(message.parts, List(ChatPart.Text("hello chat")))
    assertEquals(message.data, Map.empty[String, obseffects.domain.JsonValue])
  }

  test("a sender who chose no colour gets the deterministic hash colour and seed") {
    /*
     * The expected values were produced by a separate implementation of the derivation (a few lines of Python over
     * hashlib), not by running this code — the same rule as the obs-websocket authentication test. They must also
     * match what twitch-vizer computed for the same username, which is the whole point of the derivation: ported
     * scenes draw the same identity for the same user.
     */
    val message = built(":somelogin!somelogin@x.tmi.twitch.tv PRIVMSG #worxbend :hi")

    assertEquals(message.color, "#257680")
    assertEquals(message.seed, 7766019)
    assertEquals(message.displayName, "somelogin")
    assertEquals(message.id, "fallback-id")
  }

  test("a /me message loses its CTCP ACTION wrapper and its emote offsets align with the inner text") {
    // `/me Kappa` arrives as the trailing parameter "\u0001ACTION Kappa\u0001", and the `emotes` tag offsets
    // (0-4 here) are relative to the inner text with the wrapper stripped.
    val message = built(
      "@id=m1;emotes=25:0-4 :u!u@u.tmi.twitch.tv PRIVMSG #chan :\u0001ACTION Kappa\u0001"
    )

    assertEquals(message.text, "Kappa")
    assertEquals(
      message.parts,
      List(
        ChatPart.Image(
          "Kappa",
          "https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0",
          Some("https://static-cdn.jtvnw.net/emoticons/v2/25/animated/dark/3.0")
        )
      )
    )
  }

  test("a bits tag turns a chat line into a cheer carrying the amount") {
    val message = built("@bits=250;id=m1 :fan!fan@x.tmi.twitch.tv PRIVMSG #worxbend :Cheer250 nice one")

    assertEquals(message.event, ChatEventKind.Cheer)
    assertEquals(message.data, Map[String, obseffects.domain.JsonValue]("bits" -> JsonNumber(250.0)))
  }

  // -------------------------------------------------------------------------------------------
  // USERNOTICE
  // -------------------------------------------------------------------------------------------

  test("a resub becomes a sub event with tier and months, reading the escaped system message") {
    val message = built(
      "@msg-id=resub;login=fan;display-name=Fan;msg-param-sub-plan=1000;msg-param-cumulative-months=7;" +
        """system-msg=Fan\ssubscribed\sat\sTier\s1. """ +
        ":tmi.twitch.tv USERNOTICE #worxbend :my own message"
    )

    assertEquals(message.event, ChatEventKind.Sub)
    assertEquals(message.username, "fan")
    assertEquals(message.text, "Fan subscribed at Tier 1.")
    assertEquals(
      message.data,
      Map[String, obseffects.domain.JsonValue]("tier" -> JsonString("1000"), "months" -> JsonNumber(7.0))
    )
  }

  test("a mystery gift becomes a gift_sub carrying the count, and a single gift counts as one") {
    val mystery = built(
      "@msg-id=submysterygift;login=santa;msg-param-mass-gift-count=5 :tmi.twitch.tv USERNOTICE #worxbend"
    )
    assertEquals(mystery.event, ChatEventKind.GiftSub)
    assertEquals(mystery.data, Map[String, obseffects.domain.JsonValue]("total" -> JsonNumber(5.0)))

    val single = built("@msg-id=subgift;login=santa :tmi.twitch.tv USERNOTICE #worxbend")
    assertEquals(single.data, Map[String, obseffects.domain.JsonValue]("total" -> JsonNumber(1.0)))
  }

  test("a raid becomes a raid event carrying the viewer count") {
    val message = built(
      "@msg-id=raid;login=raider;msg-param-viewerCount=42 :tmi.twitch.tv USERNOTICE #worxbend"
    )

    assertEquals(message.event, ChatEventKind.Raid)
    assertEquals(message.data, Map[String, obseffects.domain.JsonValue]("viewers" -> JsonNumber(42.0)))
  }

  test("a USERNOTICE kind the overlays do not draw is dropped rather than guessed at") {
    val message = parsed("@msg-id=announcement;login=mod :tmi.twitch.tv USERNOTICE #worxbend :big news")
    assertEquals(TwitchIrcClient.chatMessage(message, at, "x"), None)
  }

  test("commands that are not chat produce no message") {
    assertEquals(TwitchIrcClient.chatMessage(parsed("PING :tmi.twitch.tv"), at, "x"), None)
  }

  // -------------------------------------------------------------------------------------------
  // Protocol odds and ends
  // -------------------------------------------------------------------------------------------

  test("a PING is answered with a PONG echoing the server's token") {
    assertEquals(TwitchIrcClient.pongFor(parsed("PING :tmi.twitch.tv")), "PONG :tmi.twitch.tv")
  }

  test("a login-failure NOTICE is recognised and an informational NOTICE is not") {
    val failure = parsed(":tmi.twitch.tv NOTICE * :Login authentication failed")
    assertEquals(TwitchIrcClient.authFailureReason(failure), Some("Login authentication failed"))

    val slowMode = parsed("@msg-id=slow_on :tmi.twitch.tv NOTICE #chan :This room is now in slow mode.")
    assertEquals(TwitchIrcClient.authFailureReason(slowMode), None)
  }

  test("the anonymous nick is justinfan plus digits, whatever number it is fed") {
    assertEquals(TwitchIrcClient.anonymousNick(12345), "justinfan12345")
    // Negative inputs still land in the same digit range — floorMod, not the sign-keeping %.
    assert(TwitchIrcClient.anonymousNick(-7).matches("justinfan\\d+"))
  }

  test("a normal close is not reported as a failure, and any other code keeps its number") {
    assertEquals(TwitchIrcClient.closeExplanation(java.net.http.WebSocket.NORMAL_CLOSURE, "bye"), None)
    val other = TwitchIrcClient.closeExplanation(1006, "gone")
    assert(other.exists(_.contains("1006")), s"got $other")
  }
}
