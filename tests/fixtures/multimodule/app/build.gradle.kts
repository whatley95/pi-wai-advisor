plugins {
    id("org.springframework.boot") version "3.1.4"
    java
}
dependencies {
    implementation(project(":common"))
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
}
