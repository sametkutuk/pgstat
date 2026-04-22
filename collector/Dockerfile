FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline -q
COPY src ./src
RUN mvn package -DskipTests -q

FROM eclipse-temurin:17-jre
RUN groupadd -g 10001 pgstat 2>/dev/null || true && \
    useradd -u 10001 -g 10001 -s /bin/sh pgstat 2>/dev/null || true
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
RUN chown 10001:10001 /app/app.jar
RUN mkdir -p /app/data/secrets && chown -R 10001:10001 /app/data
USER 10001
ENTRYPOINT ["java", "-jar", "app.jar"]
