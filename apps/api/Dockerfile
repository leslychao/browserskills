FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY contracts/package.json ./contracts/package.json
COPY apps/browser/package.json ./apps/browser/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --ignore-scripts
COPY contracts ./contracts
COPY apps/web ./apps/web
RUN npm run build --workspace @browserskills/web

FROM maven:3.9.16-eclipse-temurin-21@sha256:8f6ac126f7810bb5549c4cd122d2bf0e9cda5bdeb0838aa928f09e779fd8bef8 AS build
WORKDIR /build
COPY apps/api/pom.xml ./pom.xml
RUN mvn -B -q dependency:go-offline
COPY apps/api/src ./src
COPY --from=web /build/apps/web/dist ./src/main/resources/static
RUN mvn -B -q -DskipTests package

FROM eclipse-temurin:21-jre-jammy@sha256:eebd356ad7358b7094758e5787a6726f332917cfd56feab6457c56dab895cdbf
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home app && mkdir -p /data/materials /app/config && chown -R app:app /data/materials
WORKDIR /app
COPY --from=build /build/target/browserskills-api-0.1.0.jar /app/api.jar
COPY ops/inference/quality-evidence.json /app/config/quality-evidence.json
ENV API_MATERIALS_DIR=/data/materials API_QUALITY_EVIDENCE_PATH=/app/config/quality-evidence.json
USER 10001
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=70", "-Djava.io.tmpdir=/tmp", "-jar", "/app/api.jar"]
