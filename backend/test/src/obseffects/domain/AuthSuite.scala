package obseffects.domain

import munit.FunSuite

import java.security.SecureRandom

/** The authentication primitives: reading a hash, checking a password against it, and minting and comparing session
  * tokens.
  *
  * Every hash used here is produced by `Passwords.hash` at cost 4 rather than pasted in as a literal. Two reasons: a
  * reader can see which password each hash belongs to, and cost 4 is the cheapest bcrypt accepts, which keeps the suite
  * at milliseconds instead of the quarter-second per hash that the recommended cost of 12 would spend.
  */
class AuthSuite extends FunSuite {

  private val TestCost = 4

  private val random = new SecureRandom()

  // -------------------------------------------------------------------------------------------
  // Reading a hash out of the environment
  // -------------------------------------------------------------------------------------------

  test("a hash produced by this project is one this project accepts") {
    val hash = Passwords.hash("correct horse battery staple", TestCost)
    assertEquals(PasswordHash.parse(hash.value).map(_.value), Right(hash.value))
  }

  test("all four bcrypt version markers are accepted, because different tools emit different ones") {
    // htpasswd writes $2y$, most Python and Node libraries write $2b$; $2a$ and $2x$ are older.
    val salt = "N9qo8uLOickgx2ZMRZoMye"
    val digest = "IjZAgcfl7p92ldGxad68LJZdL17lhWy"
    List("2a", "2b", "2x", "2y").foreach { version =>
      val candidate = s"$$$version$$12$$$salt$digest"
      assert(PasswordHash.parse(candidate).isRight, s"$version should be accepted")
    }
  }

  test("a hash with the wrong shape is rejected with an explanation rather than accepted") {
    val rejected = List(
      "" -> "empty",
      "hunter2" -> "a plain password rather than a hash",
      "$2z$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy" -> "unknown version marker",
      "$2y$99$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy" -> "impossible cost factor",
      "$2y$12$tooshort" -> "truncated"
    )

    rejected.foreach { (candidate, why) =>
      PasswordHash.parse(candidate) match {
        case Left(message) => assert(message.contains("bcrypt"), s"the message for '$why' should mention bcrypt")
        case Right(_)      => fail(s"a hash that is $why should not be accepted")
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Checking a password
  // -------------------------------------------------------------------------------------------

  test("the right password verifies") {
    val hash = Passwords.hash("s3cret-overlay", TestCost)
    assert(Passwords.verify("s3cret-overlay", hash))
  }

  test("the wrong password does not verify") {
    val hash = Passwords.hash("s3cret-overlay", TestCost)
    assert(!Passwords.verify("s3cret-overlays", hash))
    assert(!Passwords.verify("S3CRET-OVERLAY", hash))
    assert(!Passwords.verify("", hash))
  }

  test("a malformed hash verifies nothing rather than throwing") {
    // This is the failure mode `Main` prevents by refusing to start on an unreadable hash. If one
    // ever reaches the verifier anyway, the answer must be "no" and not an exception, because an
    // exception here is a 500 on the login endpoint.
    val nonsense = PasswordHash.unsafe("not-a-bcrypt-hash")
    assert(!Passwords.verify("anything", nonsense))
  }

  test("a hash produced by Apache htpasswd verifies, because that is what the documentation tells people to use") {
    // Generated with the exact command in backend/README.md, at cost 5 so this suite stays fast:
    //   docker run --rm httpd:2.4-alpine htpasswd -nbBC 5 "" 'known-test-password'
    // htpasswd writes the $2y$ marker, so this also pins that a hash made by another tool — with a
    // different version marker than the one this project's own tool emits — is accepted.
    val fromHtpasswd = PasswordHash.unsafe("$2y$05$D70rlfPvBn/H5RQvwUTZWuRXcpgGMkU3RQABG58t8Ue.k1dabpDQy")

    assert(PasswordHash.parse(fromHtpasswd.value).isRight)
    assert(Passwords.verify("known-test-password", fromHtpasswd))
    assert(!Passwords.verify("some-other-password", fromHtpasswd))
  }

  test("a password longer than bcrypt can read is answered, not thrown at") {
    // bcrypt only ever looks at the first 72 bytes, and this library's default is to refuse a
    // longer password with an exception. On the login endpoint that exception would be a 500 where
    // the contract promises a 401, so the truncating strategy — the one every other bcrypt
    // implementation uses — is selected explicitly in Passwords.
    val long = "p" * 200
    val hash = Passwords.hash(long, TestCost)

    assert(Passwords.verify(long, hash))
    assert(!Passwords.verify("q" * 200, hash))
  }

  test("two long passwords sharing their first 72 bytes are the same password to bcrypt") {
    // The honest consequence of truncating, written down rather than left to be discovered. It is
    // how every bcrypt deployment behaves, including the ones that produced the hash in the test
    // above, which is exactly why this project matches them instead of being stricter alone.
    val hash = Passwords.hash("z" * 72 + "first-ending", TestCost)
    assert(Passwords.verify("z" * 72 + "a-completely-different-ending", hash))
  }

  test("hashing the same password twice produces two different hashes, both of which verify") {
    // Each hash embeds its own random salt. That is why a stolen hash file cannot be attacked by
    // looking values up in a precomputed table.
    val first = Passwords.hash("same-password", TestCost)
    val second = Passwords.hash("same-password", TestCost)
    assertNotEquals(first.value, second.value)
    assert(Passwords.verify("same-password", first))
    assert(Passwords.verify("same-password", second))
  }

  // -------------------------------------------------------------------------------------------
  // Session tokens
  // -------------------------------------------------------------------------------------------

  test("a generated token is 43 Base64url characters") {
    val token = SessionToken.generate(random)
    assertEquals(token.value.length, SessionToken.EncodedLength)
    assert(token.value.forall(character => character.isLetterOrDigit || character == '-' || character == '_'))
  }

  test("generated tokens do not repeat") {
    // Not a proof of randomness — nothing in a unit test can be — but it does catch the mistake of
    // generating one token and reusing it, which would hand every visitor the same session.
    val tokens = List.fill(200)(SessionToken.generate(random).value)
    assertEquals(tokens.distinct.size, tokens.size)
  }

  test("a token round-trips through parse, and anything of the wrong shape does not parse at all") {
    val token = SessionToken.generate(random)
    assertEquals(SessionToken.parse(token.value).map(_.value), Some(token.value))

    assertEquals(SessionToken.parse(""), None)
    assertEquals(SessionToken.parse("short"), None)
    assertEquals(SessionToken.parse(token.value + "x"), None)
    // `+` and `/` belong to standard Base64, not to the url-safe alphabet a cookie value uses.
    assertEquals(SessionToken.parse("+" * SessionToken.EncodedLength), None)
  }

  // -------------------------------------------------------------------------------------------
  // The constant-time comparison
  // -------------------------------------------------------------------------------------------

  test("constant-time comparison answers the same as equality would") {
    // Timing cannot be asserted on reliably in a unit test — a garbage collection pause dwarfs the
    // difference being defended against. What *can* be pinned down is that the timing-safe compare
    // is still a correct compare, which is the property a future refactor could break.
    val token = SessionToken.generate(random)
    val same = SessionToken.unsafe(token.value)
    val different = SessionToken.generate(random)

    assert(token.matches(same))
    assert(!token.matches(different))
  }

  test("tokens differing only in the last character do not match") {
    // The case that a first-character-only comparison would get wrong.
    val base = "a" * (SessionToken.EncodedLength - 1)
    val left = SessionToken.unsafe(base + "b")
    val right = SessionToken.unsafe(base + "c")
    assert(!left.matches(right))
  }

  test("tokens differing only in the first character do not match") {
    // And the mirror image: the case a comparison that gave up early would get right for the wrong
    // reason. Both are here so that "it stops at the first difference" and "it reads the whole
    // value" are indistinguishable in behaviour, which is exactly the point.
    val tail = "a" * (SessionToken.EncodedLength - 1)
    val left = SessionToken.unsafe("b" + tail)
    val right = SessionToken.unsafe("c" + tail)
    assert(!left.matches(right))
  }

  test("a token matches itself") {
    val token = SessionToken.generate(random)
    assert(token.matches(token))
  }
}
