package obseffects.application

import munit.FunSuite
import obseffects.domain.TwitchSettings

/** Tests for the Twitch moderation use cases.
  *
  * Three rules get most of the attention here, because they are the three that would be worst to get wrong and quietest
  * in review:
  *
  *   1. **The feature is optional.** Every way an installation can be unconfigured has to be an ordinary answer — a
  *      described status, or a refusal naming what is missing — and never an exception or a 500.
  *   2. **A bulk operation never aborts on one bad user.** Ninety-nine of a hundred still have to land.
  *   3. **An expired token is recovered from once.** A `401` refreshes and retries exactly once, and a second `401`
  *      gives up instead of looping.
  */
class TwitchAdminServiceSuite extends FunSuite {

  /** A fully configured installation: enabled, a channel, an application, a token, both required scopes, and both ids
    * already known — so nothing has to be looked up before the operation under test runs.
    */
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
    scopes = List(
      TwitchAdminService.ScopeReadBans,
      TwitchAdminService.ScopeManageBans,
      TwitchAdminService.ScopeReadModerators
    )
  )

  private val known = List(
    TwitchUser("1", "alice", "Alice"),
    TwitchUser("2", "bob", "Bob"),
    TwitchUser("3", "carol", "Carol")
  )

  private def service(
      settings: TwitchSettings = configured,
      helix: FakeTwitchHelix = new FakeTwitchHelix(users = known),
      exchanger: StubTwitchTokenExchanger = new StubTwitchTokenExchanger()
  ): (TwitchAdminService, FakeSettingsRepository, FakeTwitchHelix) = {
    val repository = new FakeSettingsRepository(initialTwitch = settings)
    // No pause between requests: the rate-limit gap is a production concern and would only make the suite slow.
    (new TwitchAdminService(repository, helix, exchanger, pauseMillis = 0L), repository, helix)
  }

  // -------------------------------------------------------------------------------------------
  // Availability — the "this feature is optional" matrix
  // -------------------------------------------------------------------------------------------

  test("a fully configured installation reports itself available, with the ids and scopes it knows") {
    val (admin, _, _) = service()

    val status = admin.status()

    assert(status.available, s"expected available, got $status")
    assertEquals(status.reason, None)
    assertEquals(status.channel, "worxbend")
    assertEquals(status.broadcasterId, Some("777"))
    assertEquals(status.moderatorLogin, Some("botty"))
    assertEquals(status.missingScopes, Nil)
  }

  test("every unconfigured shape answers with a reason instead of failing, and names what to fix first") {
    val cases = List(
      configured.copy(enabled = false) -> "switched off",
      configured.copy(channel = "") -> "channel",
      configured.copy(clientId = "") -> "client id",
      configured.copy(clientSecret = None) -> "client id",
      configured.copy(accessToken = None) -> "No Twitch account is connected",
      configured.copy(scopes = List(TwitchAdminService.ScopeReadBans)) -> TwitchAdminService.ScopeManageBans
    )

    cases.foreach { (settings, expected) =>
      val (admin, _, _) = service(settings)
      val status = admin.status()

      assert(!status.available, s"expected unavailable for $settings, got $status")
      assert(
        status.reason.exists(_.contains(expected)),
        s"expected a reason mentioning '$expected', got ${status.reason}"
      )
    }
  }

  test("an unavailable installation refuses an action with TWITCH_UNAVAILABLE, never an exception") {
    val (admin, _, helix) = service(TwitchSettings.Default)

    val bans = admin.bans(cursor = None, limit = None)
    val banned = admin.banMany(List("alice"), durationSeconds = None, reason = None)

    assert(bans.left.exists(_.isInstanceOf[AppError.TwitchUnavailable]), s"got $bans")
    assert(banned.left.exists(_.isInstanceOf[AppError.TwitchUnavailable]), s"got $banned")
    // Nothing was sent anywhere: an unconfigured installation must not talk to Twitch at all.
    assertEquals(helix.calls, Nil)
  }

  test("the status endpoint's answer still describes the channel while the feature is unavailable") {
    val (admin, _, _) = service(configured.copy(scopes = List("chat:read")))

    val status = admin.status()

    assertEquals(status.channel, "worxbend")
    assertEquals(status.grantedScopes, List("chat:read"))
    assertEquals(
      status.missingScopes,
      List(
        TwitchAdminService.ScopeReadBans,
        TwitchAdminService.ScopeManageBans,
        TwitchAdminService.ScopeReadModerators
      )
    )
  }

  test("scopes and the moderator id are learned from Twitch once and remembered") {
    val exchanger = new StubTwitchTokenExchanger(
      validate = Right(
        TwitchTokenInfo("botty", "42", List(TwitchAdminService.ScopeReadBans, TwitchAdminService.ScopeManageBans))
      )
    )
    val (admin, repository, _) = service(configured.copy(botUserId = None, scopes = Nil), exchanger = exchanger)

    assert(admin.status().available, "expected the validate call to make it available")
    assertEquals(repository.loadTwitch().botUserId, Some("42"))
    assertEquals(repository.loadTwitch().scopes.size, 2)

    // The second call reads what was stored rather than asking Twitch again — a dashboard polls this endpoint.
    val _ = admin.status()
    assertEquals(exchanger.calls.count(_.startsWith("validate")), 1)
  }

  test("an access token that expired before the first check is refreshed instead of reported as broken") {
    // The reachable shape: the operator pasted tokens (which clears the id and the scopes), the chat connection never
    // completed, and the four-hour access token expired. A usable refresh token is stored the whole time, so telling
    // the operator to reconnect their account would be wrong — nothing is wrong with it.
    val exchanger = new StubTwitchTokenExchanger(
      refresh = Right(TwitchTokenPair("access-2", Some("refresh-2"))),
      validate = Left("invalid access token"),
      validatePerToken = Map(
        "access-2" -> Right(
          TwitchTokenInfo("botty", "42", List(TwitchAdminService.ScopeReadBans, TwitchAdminService.ScopeManageBans))
        )
      )
    )
    val (admin, repository, _) = service(configured.copy(botUserId = None, scopes = Nil), exchanger = exchanger)

    val status = admin.status()

    assert(status.available, s"expected the refresh to recover it, got $status")
    assertEquals(status.reason, None)
    assertEquals(repository.loadTwitch().accessToken, Some("access-2"))
    assertEquals(repository.loadTwitch().botUserId, Some("42"))
    assertEquals(exchanger.calls, List("validate access-1", "refresh refresh-1", "validate access-2"))
  }

  test("a refreshed token Twitch still refuses gives up rather than refreshing again") {
    val exchanger = new StubTwitchTokenExchanger(
      refresh = Right(TwitchTokenPair("access-2", Some("refresh-2"))),
      validate = Left("invalid access token")
    )
    val (admin, _, _) = service(configured.copy(botUserId = None, scopes = Nil), exchanger = exchanger)

    val status = admin.status()

    assert(!status.available, s"got $status")
    assert(status.reason.exists(_.contains("invalid access token")), s"got ${status.reason}")
    assertEquals(exchanger.calls.count(_.startsWith("refresh")), 1)
  }

  test("a token that carries no scopes at all is still only validated once") {
    // An empty scope list reads exactly like "never asked", so a cache keyed on the scopes would send this
    // installation to Twitch's validate endpoint on every single request while learning nothing new.
    val exchanger = new StubTwitchTokenExchanger(validate = Right(TwitchTokenInfo("botty", "42", Nil)))
    val (admin, _, _) = service(configured.copy(botUserId = None, scopes = Nil), exchanger = exchanger)

    val first = admin.status()
    val second = admin.status()

    assert(!first.available, s"a token with no scopes cannot moderate: $first")
    assertEquals(second.grantedScopes, Nil)
    assertEquals(exchanger.calls.count(_.startsWith("validate")), 1)
  }

  test("a token Twitch will not validate is an explained unavailability, not a failure") {
    val exchanger = new StubTwitchTokenExchanger(validate = Left("invalid access token"))
    val (admin, _, _) = service(configured.copy(botUserId = None, scopes = Nil), exchanger = exchanger)

    val status = admin.status()

    assert(!status.available, s"got $status")
    assert(status.reason.exists(_.contains("invalid access token")), s"got ${status.reason}")
  }

  test("the channel's numeric id is looked up once and cached in the settings") {
    val helix = new FakeTwitchHelix(users = TwitchUser("777", "worxbend", "Worxbend") :: known)
    val (admin, repository, _) = service(configured.copy(broadcasterId = None), helix)

    val status = admin.status()

    assertEquals(status.broadcasterId, Some("777"))
    assertEquals(repository.loadTwitch().broadcasterId, Some("777"))
  }

  test("a channel Twitch has never heard of is reported as such rather than moderating nothing") {
    val (admin, _, _) = service(configured.copy(channel = "ghost", broadcasterId = None))

    val status = admin.status()

    assert(!status.available, s"got $status")
    assert(status.reason.exists(_.contains("ghost")), s"got ${status.reason}")
  }

  test("the moderator list needs its own scope, and its absence disables only that panel") {
    val without = configured.copy(scopes = List(TwitchAdminService.ScopeReadBans, TwitchAdminService.ScopeManageBans))
    val (admin, _, _) = service(without)

    assert(admin.status().available, "the dashboard itself must stay available")
    assert(admin.bans(None, None).isRight, "the ban list must still work")
    admin.moderators(cursor = None) match {
      case Left(AppError.TwitchUnavailable(reason)) =>
        assert(reason.contains(TwitchAdminService.ScopeReadModerators), reason)
      case other => fail(s"expected a refusal naming the missing scope, got $other")
    }
  }

  // -------------------------------------------------------------------------------------------
  // Input handling
  // -------------------------------------------------------------------------------------------

  test("logins are de-duplicated without regard to case, stripped of a leading @, and blanks dropped") {
    val (admin, _, helix) = service()

    val result = admin.banMany(List(" @Alice ", "alice", "", "  ", "BOB"), durationSeconds = None, reason = None)

    assertEquals(result.map(_.outcomes.map(_.login)), Right(List("Alice", "BOB")))
    assertEquals(helix.calls.head, "resolve[access-1] Alice,BOB")
  }

  test("a request naming nobody, and one naming more than a hundred accounts, are validation failures") {
    val (admin, _, helix) = service()

    val empty = admin.banMany(List("", "   "), durationSeconds = None, reason = None)
    val tooMany = admin.banMany((1 to 101).map(index => s"user$index").toList, None, None)

    assertEquals(empty.left.map(issueFields), Left(List("users")))
    assertEquals(tooMany.left.map(issueFields), Left(List("users")))
    assertEquals(helix.calls, Nil)
  }

  test("exactly a hundred accounts is allowed, because that is what one Twitch lookup resolves") {
    val (admin, _, _) = service()

    val result = admin.banMany((1 to 100).map(index => s"user$index").toList, None, None)

    assertEquals(result.map(_.outcomes.size), Right(100))
  }

  test("a timeout duration outside 1..1209600 seconds is rejected before anything is sent") {
    val (admin, _, helix) = service()

    assertEquals(admin.banMany(List("alice"), Some(0), None).left.map(issueFields), Left(List("durationSeconds")))
    assertEquals(admin.banMany(List("alice"), Some(1209601), None).left.map(issueFields), Left(List("durationSeconds")))
    assertEquals(helix.calls, Nil)
  }

  test("an absent duration is a permanent ban and a present one is a timeout — the same Twitch call either way") {
    val (admin, _, helix) = service()

    val _ = admin.banMany(List("alice"), durationSeconds = None, reason = Some(" spam "))
    val _ = admin.banMany(List("bob"), durationSeconds = Some(600), reason = None)

    assertEquals(
      helix.calls.filter(_.startsWith("ban")),
      List("ban[access-1] alice duration=-", "ban[access-1] bob duration=600")
    )
  }

  test("a page limit outside 1..100 is rejected") {
    val (admin, _, _) = service()

    assertEquals(admin.bans(None, Some(0)).left.map(issueFields), Left(List("limit")))
    assertEquals(admin.bans(None, Some(101)).left.map(issueFields), Left(List("limit")))
  }

  // -------------------------------------------------------------------------------------------
  // Bulk fan-out
  // -------------------------------------------------------------------------------------------

  test("one refused user does not stop the batch, and every outcome comes back in input order") {
    val helix = new FakeTwitchHelix(
      users = known,
      banAnswers = Map("bob" -> Left(HelixFailure.Message("The user specified in the user_id field is already banned")))
    )
    val (admin, _, _) = service(helix = helix)

    val result = admin.banMany(List("alice", "bob", "nobody", "carol"), durationSeconds = None, reason = None)

    result match {
      case Right(bulk) =>
        assertEquals(bulk.outcomes.map(_.login), List("alice", "bob", "nobody", "carol"))
        assertEquals(bulk.outcomes.map(_.ok), List(true, false, false, true))
        assertEquals(bulk.succeeded, 2)
        assertEquals(bulk.failed, 2)
        // Twitch's own words for the refusal, and our own for a name Twitch does not know.
        assert(bulk.outcomes(1).message.exists(_.contains("already banned")), s"got ${bulk.outcomes(1)}")
        assertEquals(bulk.outcomes(2).message, Some("no such Twitch account"))
      case other => fail(s"expected a partial success, got $other")
    }
  }

  test("a login Twitch does not know costs no request at all") {
    val (admin, _, helix) = service()

    val _ = admin.unbanMany(List("nobody", "alice"), Nil)

    assertEquals(helix.calls.filter(_.startsWith("unban")), List("unban[access-1] alice"))
  }

  test("the whole batch resolves in one lookup, so a hundred users cost one lookup and a hundred actions") {
    val (admin, _, helix) = service()

    val _ = admin.unbanMany(List("alice", "bob", "carol"), Nil)

    assertEquals(helix.calls.count(_.startsWith("resolve")), 1)
    assertEquals(helix.calls.count(_.startsWith("unban")), 3)
  }

  // -------------------------------------------------------------------------------------------
  // Unbanning by id — the ban list's path
  // -------------------------------------------------------------------------------------------

  test("a request made only of ban-list rows never asks Twitch who those logins are") {
    // This is the whole point of the id path. A login can be renamed and re-registered by somebody else between the
    // ban list being drawn and Unban being pressed, so looking the name up again could free a different account; going
    // straight to the stored id cannot.
    val (admin, _, helix) = service()

    val result = admin.unbanMany(Nil, List(TwitchUnbanTarget("1", "alice"), TwitchUnbanTarget("2", "bob")))

    assertEquals(result.map(_.succeeded), Right(2))
    assertEquals(helix.calls.count(_.startsWith("resolve")), 0)
    assertEquals(helix.calls, List("unban[access-1] alice", "unban[access-1] bob"))
  }

  test("a request naming rows and logins acts on both, with every row's outcome before every login's") {
    val (admin, _, helix) = service()

    val result = admin.unbanMany(List("carol", "nobody"), List(TwitchUnbanTarget("2", "bob")))

    result match {
      case Right(bulk) =>
        assertEquals(bulk.outcomes.map(_.login), List("bob", "carol", "nobody"))
        assertEquals(bulk.outcomes.map(_.ok), List(true, true, false))
        // Only the logins were looked up; the row went straight out with its id.
        assertEquals(helix.calls.filter(_.startsWith("resolve")), List("resolve[access-1] carol,nobody"))
        assertEquals(helix.calls.filter(_.startsWith("unban")), List("unban[access-1] bob", "unban[access-1] carol"))
      case other => fail(s"expected a partial success, got $other")
    }
  }

  test("the hundred-account limit counts rows and logins together") {
    val (admin, _, helix) = service()
    val rows = (1 to 60).map(index => TwitchUnbanTarget(index.toString, s"user$index")).toList
    val logins = (61 to 101).map(index => s"user$index").toList

    // 60 + 41 is 101, so neither list is over the limit on its own but the request is.
    assertEquals(admin.unbanMany(logins, rows).left.map(issueFields), Left(List("users")))
    // 60 + 40 is exactly the limit, and that is allowed.
    assertEquals(admin.unbanMany(logins.tail, rows).map(_.outcomes.size), Right(100))
    // One lookup in total, from the accepted request: the rejected one was refused before anything was sent.
    assertEquals(helix.calls.count(_.startsWith("resolve")), 1)
  }

  test("a request naming neither a row nor a login is a validation failure") {
    val (admin, _, helix) = service()

    assertEquals(admin.unbanMany(List("", "  "), Nil).left.map(issueFields), Left(List("users")))
    assertEquals(helix.calls, Nil)
  }

  test("two rows naming the same account are unbanned once") {
    // The ban list should never show one account twice, but a stale page merged with a fresh one can, and a second
    // unban would come back as Twitch's "not banned" refusal against a request that did nothing wrong.
    val (admin, _, helix) = service()

    val result = admin.unbanMany(Nil, List(TwitchUnbanTarget("1", "alice"), TwitchUnbanTarget("1", "Alice")))

    assertEquals(result.map(_.outcomes.map(_.login)), Right(List("alice")))
    assertEquals(helix.calls.count(_.startsWith("unban")), 1)
  }

  test("a row Twitch refuses does not stop the rows after it") {
    val helix = new FakeTwitchHelix(
      users = known,
      unbanAnswers = Map("bob" -> Left(HelixFailure.Message("The user specified in the user_id field is not banned")))
    )
    val (admin, _, _) = service(helix = helix)

    val result = admin.unbanMany(
      Nil,
      List(TwitchUnbanTarget("1", "alice"), TwitchUnbanTarget("2", "bob"), TwitchUnbanTarget("3", "carol"))
    )

    result match {
      case Right(bulk) =>
        assertEquals(bulk.outcomes.map(_.ok), List(true, false, true))
        assertEquals(bulk.succeeded, 2)
        assert(bulk.outcomes(1).message.exists(_.contains("not banned")), s"got ${bulk.outcomes(1)}")
      case other => fail(s"expected a partial success, got $other")
    }
  }

  // -------------------------------------------------------------------------------------------
  // The expired-token path
  // -------------------------------------------------------------------------------------------

  test("a 401 refreshes the token once, stores the new pair, and retries that call exactly once") {
    // The fake accepts only the refreshed token, so every call made with the stored one answers 401.
    val helix = new FakeTwitchHelix(users = known, acceptedToken = Some("access-2"))
    val exchanger = new StubTwitchTokenExchanger(refresh = Right(TwitchTokenPair("access-2", Some("refresh-2"))))
    val (admin, repository, _) = service(helix = helix, exchanger = exchanger)

    val result = admin.bans(cursor = None, limit = Some(10))

    assert(result.isRight, s"expected the retry to succeed, got $result")
    assertEquals(helix.calls, List("bans[access-1] cursor=- limit=10", "bans[access-2] cursor=- limit=10"))
    // The rotated pair is stored immediately: Twitch rotates the refresh token too, so the old one may already be dead.
    assertEquals(repository.loadTwitch().accessToken, Some("access-2"))
    assertEquals(repository.loadTwitch().refreshToken, Some("refresh-2"))
  }

  test("a second 401 gives up instead of refreshing again") {
    // Nothing the fake is ever given will be accepted, so the retry meets a 401 too.
    val helix = new FakeTwitchHelix(users = known, acceptedToken = Some("never-issued"))
    val exchanger = new StubTwitchTokenExchanger(refresh = Right(TwitchTokenPair("access-2", Some("refresh-2"))))
    val (admin, _, _) = service(helix = helix, exchanger = exchanger)

    val result = admin.bans(cursor = None, limit = None)

    assert(result.left.exists(_.isInstanceOf[AppError.TwitchUnavailable]), s"got $result")
    assertEquals(helix.calls.size, 2)
    assertEquals(exchanger.calls.count(_.startsWith("refresh")), 1)
  }

  test("one refresh serves the rest of a batch: the remaining users go out with the new token") {
    val helix = new FakeTwitchHelix(users = known, acceptedToken = Some("access-2"))
    val exchanger = new StubTwitchTokenExchanger(refresh = Right(TwitchTokenPair("access-2", None)))
    val (admin, _, _) = service(helix = helix, exchanger = exchanger)

    val result = admin.unbanMany(List("alice", "bob", "carol"), Nil)

    assertEquals(result.map(_.succeeded), Right(3))
    // The resolution meets the 401, refreshes, and every unban afterwards presents the fresh token — one refresh in
    // total, not one per user.
    assertEquals(exchanger.calls.count(_.startsWith("refresh")), 1)
    assertEquals(helix.calls.filter(_.startsWith("unban")).forall(_.contains("access-2")), true)
  }

  test("a refresh that Twitch refuses is reported as unavailability rather than crashing the request") {
    val helix = new FakeTwitchHelix(users = known, acceptedToken = Some("access-2"))
    val exchanger = new StubTwitchTokenExchanger(refresh = Left("Invalid refresh token"))
    val (admin, _, _) = service(helix = helix, exchanger = exchanger)

    val result = admin.bans(cursor = None, limit = None)

    assert(result.left.exists(_.isInstanceOf[AppError.TwitchUnavailable]), s"got $result")
  }

  // -------------------------------------------------------------------------------------------
  // Paging
  // -------------------------------------------------------------------------------------------

  test("the ban list pages by cursor, and the last page reports no cursor") {
    val first = TwitchBanPage(List(TwitchBan("1", "alice", "Alice", None, None, None, None)), Some("page-2"))
    val second = TwitchBanPage(List(TwitchBan("2", "bob", "Bob", None, None, None, None)), None)
    val helix = new FakeTwitchHelix(
      users = known,
      banPages = Map(None -> Right(first), Some("page-2") -> Right(second))
    )
    val (admin, _, _) = service(helix = helix)

    assertEquals(admin.bans(None, None).map(_.cursor), Right(Some("page-2")))
    assertEquals(admin.bans(Some("page-2"), None).map(_.bans.map(_.login)), Right(List("bob")))
    assertEquals(admin.bans(Some("page-2"), None).map(_.cursor), Right(None))
  }

  test("a Twitch refusal on a whole-page read is reported as unavailability carrying Twitch's words") {
    val helix = new FakeTwitchHelix(
      users = known,
      banPages = Map(None -> Left(HelixFailure.Message("Twitch answered 429: too many requests")))
    )
    val (admin, _, _) = service(helix = helix)

    admin.bans(None, None) match {
      case Left(AppError.TwitchUnavailable(reason)) => assert(reason.contains("429"), reason)
      case other => fail(s"expected an unavailability carrying the reason, got $other")
    }
  }

  private def issueFields(error: AppError): List[String] = error match {
    case AppError.ValidationFailed(issues) => issues.map(_.field)
    case other                             => fail(s"expected a validation failure, got $other")
  }
}
