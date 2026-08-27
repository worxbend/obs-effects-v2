package obseffects.application

import munit.FunSuite
import obseffects.Fixtures

class HealthServiceSuite extends FunSuite {

  test("a reachable database reports the current inventory and route counts") {
    val effects = new InMemoryEffectRepository(List(Fixtures.plasmaField))
    val health = new HealthService(new StubDatastoreHealth(healthy = true), effects, new InMemoryRouteRepository)
    assertEquals(health.check(), Right(HealthStatus(effects = 1, routes = 0)))
  }

  test("an unreachable database is an internal error carrying the mongo:down hint") {
    val health = new HealthService(
      new StubDatastoreHealth(healthy = false),
      new InMemoryEffectRepository(),
      new InMemoryRouteRepository
    )
    assertEquals(
      health.check(),
      Left(AppError.Internal("MongoDB is not reachable", Map("mongo" -> "down")))
    )
  }
}
