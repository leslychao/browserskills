package io.browserskills.api;

import org.testcontainers.postgresql.PostgreSQLContainer;

final class PostgresFixture {
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer(
          org.testcontainers.utility.DockerImageName.parse(
                  "postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641")
              .asCompatibleSubstituteFor("postgres"));

  static {
    POSTGRES.start();
  }

  private PostgresFixture() {}
}
