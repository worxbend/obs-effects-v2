package obseffects.application

import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.TwitchSettings

/** Tests for saving the Twitch configuration and handling tokens.
  *
  * As with `SettingsServiceSuite`, the write-only secret gets the most attention: a save that silently wiped the client
  * secret — or the tokens, which the settings form never even carries — would surface much later as a failed token
  * refresh, pointing whoever debugs it at Twitch rather than at the save that erased the credential.
  */
class TwitchServiceSuite extends FunSuite {

  private val configured = TwitchSettings(
    enabled = true,
    channel = "worxbend",
    clientId = "client-1",
    clientSecret = Some("shhh"),
    accessToken = Some("access-1"),
    refreshToken = Some("refresh-1"),
    botLogin = Some("botty"),
    broadcasterId = Some("777"),
    botUserId = Some("42"),
    scopes = List("chat:read")
  )

  private def service(
      initial: TwitchSettings = TwitchSettings.Default,
      exchanger: StubTwitchTokenExchanger = new StubTwitchTokenExchanger()
  ): (TwitchService, FakeSettingsRepository, RecordingTwitchConnection, InMemoryChatMessageRepository, ChatBus) = {
    val repository = new FakeSettingsRepository(initialTwitch = initial)
    val history = new InMemoryChatMessageRepository
    val connection = new RecordingTwitchConnection
    val bus = new ChatBus
    (new TwitchService(repository, history, connection, bus, exchanger), repository, connection, history, bus)
  }

  test("a save that does not mention the client secret keeps the stored one, and never touches the tokens") {
    val (twitch, repository, _, _, _) = service(configured)

    val result = twitch.saveTwitch(
      TwitchSettingsUpdate(enabled = true, channel = "elsewhere", clientId = "client-1", clientSecret = None)
    )

    assert(result.isRight, s"expected the save to succeed, got $result")
    assertEquals(repository.loadTwitch().clientSecret, Some("shhh"))
    assertEquals(repository.loadTwitch().accessToken, Some("access-1"))
    assertEquals(repository.loadTwitch().refreshToken, Some("refresh-1"))
    assertEquals(repository.loadTwitch().channel, "elsewhere")
  }

  test("an explicit null clears the stored client secret") {
    val (twitch, repository, _, _, _) = service(configured)

    val _ = twitch.saveTwitch(
      TwitchSettingsUpdate(enabled = true, channel = "worxbend", clientId = "client-1", clientSecret = Some(None))
    )

    assertEquals(repository.loadTwitch().clientSecret, None)
  }

  test("the channel is normalised: a pasted #MixedCase name is stored lowercase without the hash") {
    val (twitch, repository, _, _, _) = service()

    val _ = twitch.saveTwitch(
      TwitchSettingsUpdate(enabled = true, channel = " #SomeChannel ", clientId = "", clientSecret = None)
    )

    assertEquals(repository.loadTwitch().channel, "somechannel")
  }

  test("a channel with impossible characters is rejected and nothing is stored or reconnected") {
    val (twitch, repository, connection, _, _) = service(configured)

    val result = twitch.saveTwitch(
      TwitchSettingsUpdate(enabled = true, channel = "not a channel!", clientId = "client-1", clientSecret = None)
    )

    result match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("channel"))
      case other                                   => fail(s"expected a validation failure on channel, got $other")
    }
    assertEquals(repository.loadTwitch(), configured)
    assertEquals(connection.applied.size, 0)
  }

  test("every successful save reconnects, because Save is the operator's 'try again now' button") {
    val (twitch, _, connection, _, _) = service(configured)
    val unchanged =
      TwitchSettingsUpdate(enabled = true, channel = "worxbend", clientId = "client-1", clientSecret = None)

    val _ = twitch.saveTwitch(unchanged)
    val _ = twitch.saveTwitch(unchanged)

    assertEquals(connection.applied.size, 2)
  }

  test("changing the channel forgets the cached broadcaster id, so the dashboard cannot moderate the old channel") {
    val (twitch, repository, _, _, _) = service(configured)

    val _ = twitch.saveTwitch(
      TwitchSettingsUpdate(enabled = true, channel = "elsewhere", clientId = "client-1", clientSecret = None)
    )

    assertEquals(repository.loadTwitch().broadcasterId, None)
  }

  test("saving without changing the channel keeps the cached broadcaster id, sparing a lookup") {
    val (twitch, repository, _, _, _) = service(configured)

    val _ = twitch.saveTwitch(
      TwitchSettingsUpdate(enabled = false, channel = "worxbend", clientId = "client-1", clientSecret = None)
    )

    assertEquals(repository.loadTwitch().broadcasterId, Some("777"))
  }

  test("storing a new token forgets the account id and scopes it was not issued for") {
    val (twitch, repository, _, _, _) = service(configured)

    val _ = twitch.storeTokens("new-access", None)

    assertEquals(repository.loadTwitch().botUserId, None)
    assertEquals(repository.loadTwitch().scopes, Nil)
  }

  test("storing tokens trims them, strips a pasted oauth: prefix, and forgets the previous bot login") {
    val (twitch, repository, connection, _, _) = service(configured)

    val result = twitch.storeTokens("  oauth:new-access  ", Some(" new-refresh "))

    assert(result.isRight, s"expected the store to succeed, got $result")
    assertEquals(repository.loadTwitch().accessToken, Some("new-access"))
    assertEquals(repository.loadTwitch().refreshToken, Some("new-refresh"))
    // The new token may belong to a different account; the connection rediscovers whose it is on its next connect.
    assertEquals(repository.loadTwitch().botLogin, None)
    assertEquals(connection.applied.size, 1)
  }

  test("a blank access token is rejected as a validation failure") {
    val (twitch, repository, _, _, _) = service(configured)

    val result = twitch.storeTokens("   ", None)

    result match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("accessToken"))
      case other                                   => fail(s"expected a validation failure on accessToken, got $other")
    }
    assertEquals(repository.loadTwitch(), configured)
  }

  test("completing OAuth exchanges the code and stores the resulting pair") {
    val exchanger = new StubTwitchTokenExchanger(exchange = Right(TwitchTokenPair("granted", Some("rotating"))))
    val (twitch, repository, connection, _, _) = service(configured, exchanger)

    val result = twitch.completeOAuth("the-code", "https://admin.example/callback")

    assert(result.isRight, s"expected the exchange to succeed, got $result")
    assertEquals(repository.loadTwitch().accessToken, Some("granted"))
    assertEquals(repository.loadTwitch().refreshToken, Some("rotating"))
    assertEquals(exchanger.calls, List("exchange client-1 the-code https://admin.example/callback"))
    assertEquals(connection.applied.size, 1)
  }

  test("completing OAuth without a stored client secret is refused before Twitch is ever contacted") {
    val exchanger = new StubTwitchTokenExchanger()
    val (twitch, _, _, _, _) = service(configured.copy(clientSecret = None), exchanger)

    val result = twitch.completeOAuth("the-code", "https://admin.example/callback")

    assert(result.left.exists(_.isInstanceOf[AppError.BadRequest]), s"expected a BadRequest, got $result")
    assertEquals(exchanger.calls, Nil)
  }

  test("a rejected code exchange surfaces Twitch's reason instead of a generic error") {
    val exchanger = new StubTwitchTokenExchanger(exchange = Left("Invalid authorization code"))
    val (twitch, _, _, _, _) = service(configured, exchanger)

    val result = twitch.completeOAuth("stale-code", "https://admin.example/callback")

    result match {
      case Left(AppError.BadRequest(message)) => assert(message.contains("Invalid authorization code"), message)
      case other                              => fail(s"expected a BadRequest carrying the reason, got $other")
    }
  }

  test("history defaults to the newest fifty and pages backwards with before") {
    val (twitch, _, _, history, _) = service(configured)
    (1 to 60).foreach(i => history.append(Fixtures.chatMessage(id = s"m$i", at = 1000L + i)))

    val newest = twitch.chatHistory(limit = None, before = None)
    assertEquals(newest.map(_.size), Right(50))
    assertEquals(newest.map(_.head.id), Right("m60"))

    val page = twitch.chatHistory(limit = Some(5), before = Some(1011L))
    assertEquals(page.map(_.map(_.id)), Right(List("m10", "m9", "m8", "m7", "m6")))
  }

  test("paging with beforeId does not skip messages that share the cursor's millisecond") {
    val (twitch, _, _, history, _) = service(configured)
    // Four messages in the same millisecond, one older. A page boundary falls inside the tie group: with the
    // timestamp-only cursor the rest of the group was invisible, because `at < 2000` excluded all of it.
    List("a", "b", "c", "d").foreach(id => history.append(Fixtures.chatMessage(id = id, at = 2000L)))
    history.append(Fixtures.chatMessage(id = "old", at = 1000L))

    val firstPage = twitch.chatHistory(limit = Some(2), before = None)
    assertEquals(firstPage.map(_.map(_.id)), Right(List("d", "c")))

    val secondPage = twitch.chatHistory(limit = Some(2), before = Some(2000L), beforeId = Some("c"))
    assertEquals(secondPage.map(_.map(_.id)), Right(List("b", "a")))

    val thirdPage = twitch.chatHistory(limit = Some(2), before = Some(2000L), beforeId = Some("a"))
    assertEquals(thirdPage.map(_.map(_.id)), Right(List("old")))
  }

  test("a history limit outside 1..200 is rejected") {
    val (twitch, _, _, _, _) = service(configured)

    val result = twitch.chatHistory(limit = Some(0), before = None)

    result match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("limit"))
      case other                                   => fail(s"expected a validation failure on limit, got $other")
    }
  }

  test("start-up seeds the snapshot ring from the stored history and applies the stored settings") {
    val (twitch, _, connection, history, bus) = service(configured)
    history.append(Fixtures.chatMessage(id = "old", at = 1000L))
    history.append(Fixtures.chatMessage(id = "new", at = 2000L))

    twitch.startTwitchChat()

    // Oldest first, because the ring feeds the snapshot frame and overlays draw top to bottom.
    assertEquals(bus.recent.map(_.id), List("old", "new"))
    assertEquals(connection.applied, List(configured))
  }
}
