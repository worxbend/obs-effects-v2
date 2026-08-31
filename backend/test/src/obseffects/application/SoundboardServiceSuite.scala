package obseffects.application

import munit.FunSuite
import obseffects.domain.{
  GroupOp,
  RawSoundboard,
  RawSoundboardCondition,
  RawSoundboardRule,
  Soundboard,
  SoundboardCondition
}

import java.security.SecureRandom

/** Tests for the soundboard use cases, run against the fake settings repository from [[SettingsServiceSuite]].
  *
  * The rules being pinned down: at most 100 rules; label and sound trimmed and 1 to 64 characters; a condition tree at
  * most 5 group levels deep with 1 to 20 children per group and at most 50 nodes in total; per-leaf value bounds (an
  * empty value is only meaningful on `emote`/`emoji`, a command has no whitespace, a regex compiles, an event names one
  * of the five kinds); a valid client-sent id is kept and a duplicate one rejected; anything else gets a fresh
  * server-assigned 8-hex id.
  */
class SoundboardServiceSuite extends FunSuite {

  private def service(): (SoundboardService, FakeSettingsRepository) = {
    val repository = new FakeSettingsRepository()
    (new SoundboardService(repository, new SecureRandom()), repository)
  }

  private def leaf(`type`: String, value: String): RawSoundboardCondition =
    RawSoundboardCondition(`type` = `type`, op = None, negate = None, children = None, value = Some(value))

  private def group(
      children: List[RawSoundboardCondition],
      op: String = "and",
      negate: Boolean = false
  ): RawSoundboardCondition =
    RawSoundboardCondition(
      `type` = "group",
      op = Some(op),
      negate = Some(negate),
      children = Some(children),
      value = None
    )

  private def rule(
      id: Option[String] = None,
      label: String = "Drum",
      condition: RawSoundboardCondition = leaf("command", "!drum"),
      sound: String = "drum",
      enabled: Boolean = true
  ): RawSoundboardRule = RawSoundboardRule(id, label, condition, sound, enabled)

  private def issuesOf(result: Either[AppError, Soundboard]): List[(String, String)] = result match {
    case Left(AppError.ValidationFailed(issues)) => issues.map(issue => (issue.field, issue.message))
    case other                                   => fail(s"expected a validation failure, got $other")
  }

  test("an unconfigured soundboard reads back as an empty rule list") {
    val (sut, _) = service()
    assertEquals(sut.get(), Soundboard.Empty)
  }

  test("a save stores the rules in order and reading them back answers the same board") {
    val (sut, repository) = service()
    val saved = sut
      .save(RawSoundboard(List(rule(label = "First"), rule(label = "Second", condition = leaf("command", "!x")))))
      .getOrElse(fail("the save should be accepted"))
    assertEquals(saved.rules.map(_.label), List("First", "Second"))
    assertEquals(repository.loadSoundboard(), saved)
    assertEquals(sut.get(), saved)
  }

  test("a rule without an id is assigned a fresh 8-hex one") {
    val (sut, _) = service()
    val saved = sut.save(RawSoundboard(List(rule()))).getOrElse(fail("should be accepted"))
    assert(SoundboardService.IdPattern.matches(saved.rules.head.id), s"got id '${saved.rules.head.id}'")
  }

  test("a valid client-sent id is kept, so it stays stable across edits") {
    val (sut, _) = service()
    val saved = sut.save(RawSoundboard(List(rule(id = Some("0badcafe"))))).getOrElse(fail("should be accepted"))
    assertEquals(saved.rules.head.id, "0badcafe")
  }

  test("an id that is not 8 lowercase hex characters is replaced with a fresh one, not rejected") {
    val (sut, _) = service()
    val saved = sut.save(RawSoundboard(List(rule(id = Some("BANANAS!"))))).getOrElse(fail("should be accepted"))
    assertNotEquals(saved.rules.head.id, "BANANAS!")
    assert(SoundboardService.IdPattern.matches(saved.rules.head.id))
  }

  test("two rules claiming the same id are a validation error naming the later rule") {
    val (sut, _) = service()
    val result = sut.save(RawSoundboard(List(rule(id = Some("0badcafe")), rule(id = Some("0badcafe")))))
    assertEquals(issuesOf(result).map(_._1), List("rules[1].id"))
  }

  test("more than 100 rules is a validation error on the list itself") {
    val (sut, _) = service()
    val many = List.tabulate(101)(i => rule(condition = leaf("command", s"!r$i")))
    assertEquals(issuesOf(sut.save(RawSoundboard(many))).map(_._1), List("rules"))
  }

  test("exactly 100 rules is accepted") {
    val (sut, _) = service()
    assert(sut.save(RawSoundboard(List.tabulate(100)(i => rule(condition = leaf("command", s"!r$i"))))).isRight)
  }

  test("label and sound are stored trimmed") {
    val (sut, _) = service()
    val saved = sut.save(RawSoundboard(List(rule(label = "  Drum  ", sound = "  drum  ")))).getOrElse(fail("accepted"))
    assertEquals(saved.rules.head.label, "Drum")
    assertEquals(saved.rules.head.sound, "drum")
  }

  test("a blank label, an unknown condition type and a blank sound are all reported together with indexed fields") {
    val (sut, _) = service()
    val result = sut.save(RawSoundboard(List(rule(), rule(label = "   ", condition = leaf("shout", "!x"), sound = ""))))
    assertEquals(
      issuesOf(result).map(_._1),
      List("rules[1].label", "rules[1].condition.type", "rules[1].sound")
    )
  }

  test("an unknown condition type names the accepted values in the message") {
    val (sut, _) = service()
    issuesOf(sut.save(RawSoundboard(List(rule(condition = leaf("shout", "!x")))))) match {
      case List((field, message)) =>
        assertEquals(field, "rules[0].condition.type")
        assert(message.contains("group, command, contains, regex, emote, emoji, event, user"), message)
      case other => fail(s"expected one issue, got $other")
    }
  }

  test("a label or sound longer than 64 characters is rejected, and exactly 64 is accepted") {
    val (sut, _) = service()
    assertEquals(
      issuesOf(sut.save(RawSoundboard(List(rule(label = "n" * 65, sound = "s" * 65))))).map(_._1),
      List("rules[0].label", "rules[0].sound")
    )
    assert(sut.save(RawSoundboard(List(rule(label = "n" * 64, sound = "s" * 64)))).isRight)
  }

  test("an empty leaf value and one longer than 200 characters are rejected, and exactly 200 is accepted") {
    val (sut, _) = service()
    assertEquals(
      issuesOf(sut.save(RawSoundboard(List(rule(condition = leaf("contains", "")))))).map(_._1),
      List("rules[0].condition.value")
    )
    assertEquals(
      issuesOf(sut.save(RawSoundboard(List(rule(condition = leaf("contains", "p" * 201)))))).map(_._1),
      List("rules[0].condition.value")
    )
    assert(sut.save(RawSoundboard(List(rule(condition = leaf("contains", "p" * 200))))).isRight)
  }

  test("an empty emote or emoji value is accepted — it means \"any emote/emoji\" — but over 200 characters is not") {
    val (sut, _) = service()
    assert(sut.save(RawSoundboard(List(rule(condition = leaf("emote", ""))))).isRight)
    assert(sut.save(RawSoundboard(List(rule(condition = leaf("emoji", ""))))).isRight)
    assertEquals(
      issuesOf(sut.save(RawSoundboard(List(rule(condition = leaf("emote", "e" * 201)))))).map(_._1),
      List("rules[0].condition.value")
    )
  }

  test("a command value with whitespace inside is rejected — a command is a single first-word token") {
    val (sut, _) = service()
    assertEquals(
      issuesOf(sut.save(RawSoundboard(List(rule(condition = leaf("command", "!drum roll")))))).map(_._1),
      List("rules[0].condition.value")
    )
  }

  test("a regex value that does not compile is rejected with the compiler's description in the message") {
    val (sut, _) = service()
    val result = sut.save(RawSoundboard(List(rule(condition = leaf("regex", "[unclosed")))))
    issuesOf(result) match {
      case List((field, message)) =>
        assertEquals(field, "rules[0].condition.value")
        assert(message.startsWith("is not a valid regular expression:"), message)
      case other => fail(s"expected one issue, got $other")
    }
  }

  test("a regex value that compiles is accepted and stored as typed, untrimmed") {
    val (sut, _) = service()
    val saved =
      sut.save(RawSoundboard(List(rule(condition = leaf("regex", "\\bhype\\b "))))).getOrElse(fail("accepted"))
    assertEquals(saved.rules.head.condition, SoundboardCondition.Regex("\\bhype\\b "))
  }

  test("an event value outside the five kinds is rejected with the accepted values in the message") {
    val (sut, _) = service()
    issuesOf(sut.save(RawSoundboard(List(rule(condition = leaf("event", "follow")))))) match {
      case List((field, message)) =>
        assertEquals(field, "rules[0].condition.value")
        assert(message.contains("chat, sub, gift_sub, cheer, raid"), message)
      case other => fail(s"expected one issue, got $other")
    }
    assert(sut.save(RawSoundboard(List(rule(condition = leaf("event", "raid"))))).isRight)
  }

  test("a nested tree within every bound is accepted and stored as the matching domain tree") {
    val (sut, _) = service()
    val condition = group(
      op = "or",
      negate = true,
      children = List(
        leaf("command", "!drum"),
        group(List(leaf("emote", ""), leaf("user", "worxbend")))
      )
    )
    val saved = sut.save(RawSoundboard(List(rule(condition = condition)))).getOrElse(fail("accepted"))
    assertEquals(
      saved.rules.head.condition,
      SoundboardCondition.Group(
        op = GroupOp.Or,
        negate = true,
        children = List(
          SoundboardCondition.Command("!drum"),
          SoundboardCondition.Group(
            op = GroupOp.And,
            negate = false,
            children = List(SoundboardCondition.Emote(""), SoundboardCondition.User("worxbend"))
          )
        )
      )
    )
  }

  test("a group with an unknown op and no children reports both problems with dotted paths") {
    val (sut, _) = service()
    val condition =
      RawSoundboardCondition(`type` = "group", op = Some("xor"), negate = None, children = None, value = None)
    assertEquals(
      issuesOf(sut.save(RawSoundboard(List(rule(condition = condition))))).map(_._1),
      List("rules[0].condition.op", "rules[0].condition.children")
    )
  }

  test("a problem inside a nested group is reported with the full dotted path to the leaf") {
    val (sut, _) = service()
    val condition = group(List(leaf("command", "!ok"), group(List(leaf("event", "follow")), op = "or")))
    assertEquals(
      issuesOf(sut.save(RawSoundboard(List(rule(condition = condition))))).map(_._1),
      List("rules[0].condition.children[1].children[0].value")
    )
  }

  test("a group with more than 20 children is rejected, and exactly 20 is accepted") {
    val (sut, _) = service()
    val tooMany = group(List.tabulate(21)(i => leaf("command", s"!c$i")))
    assertEquals(
      issuesOf(sut.save(RawSoundboard(List(rule(condition = tooMany))))).map(_._1),
      List("rules[0].condition.children")
    )
    assert(
      sut.save(RawSoundboard(List(rule(condition = group(List.tabulate(20)(i => leaf("command", s"!c$i"))))))).isRight
    )
  }

  test("groups nested deeper than 5 levels are rejected at the too-deep group, and exactly 5 is accepted") {
    val (sut, _) = service()
    def nested(levels: Int): RawSoundboardCondition =
      if (levels <= 1) group(List(leaf("command", "!deep"))) else group(List(nested(levels - 1)))
    assert(sut.save(RawSoundboard(List(rule(condition = nested(5))))).isRight)
    assertEquals(
      issuesOf(sut.save(RawSoundboard(List(rule(condition = nested(6)))))).map(_._1),
      List("rules[0].condition" + ".children[0]" * 5)
    )
  }

  test("a rule with more than 50 conditions in total is rejected, and exactly 50 is accepted") {
    val (sut, _) = service()
    // One root group plus its leaves: 49 leaves make 50 nodes, 50 leaves make 51. The 20-children-per-group cap is
    // per group, so the leaves are spread over subgroups.
    def wide(leaves: Int): RawSoundboardCondition =
      group(
        List.tabulate((leaves + 19) / 20)(chunk =>
          group(List.tabulate(math.min(20, leaves - chunk * 20))(i => leaf("command", s"!c$chunk-$i")))
        )
      )
    // wide(n) has 1 + ceil(n/20) + n nodes: 46 leaves → 50 nodes, 47 leaves → 51 nodes.
    assert(sut.save(RawSoundboard(List(rule(condition = wide(46))))).isRight)
    assertEquals(
      issuesOf(sut.save(RawSoundboard(List(rule(condition = wide(47)))))).map(_._1),
      List("rules[0].condition")
    )
  }

  test("a disabled rule keeps its enabled flag") {
    val (sut, _) = service()
    val saved = sut.save(RawSoundboard(List(rule(enabled = false)))).getOrElse(fail("accepted"))
    assertEquals(saved.rules.head.enabled, false)
  }

  test("saving an empty rule list is allowed — it is how an operator clears the board") {
    val (sut, repository) = service()
    val _ = sut.save(RawSoundboard(List(rule()))).getOrElse(fail("accepted"))
    assertEquals(sut.save(RawSoundboard(Nil)), Right(Soundboard.Empty))
    assertEquals(repository.loadSoundboard(), Soundboard.Empty)
  }

  test("a validation failure writes nothing") {
    val (sut, repository) = service()
    val _ = sut.save(RawSoundboard(List(rule(label = "Keep"))))
    val _ = sut.save(RawSoundboard(List(rule(label = ""))))
    assertEquals(repository.loadSoundboard().rules.map(_.label), List("Keep"))
  }
}
