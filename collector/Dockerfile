FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline -q
COPY src ./src
RUN mvn package -DskipTests -q

FROM eclipse-temurin:17-jre
RUN groupadd -g 1000 pgstat && useradd -u 1000 -g pgstat -s /bin/sh pgstat
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
RUN chown pgstat:pgstat /app/app.jar
USER pgstat
ENTRYPOINT ["java", "-jar", "app.jar"]
