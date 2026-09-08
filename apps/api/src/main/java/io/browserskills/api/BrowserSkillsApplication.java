package io.browserskills.api;

import java.time.Clock;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import tools.jackson.databind.json.JsonMapper;

@SpringBootApplication
public class BrowserSkillsApplication {
  public static void main(String[] args) {
    SpringApplication.run(BrowserSkillsApplication.class, args);
  }

  @Bean
  Clock clock() {
    return Clock.systemUTC();
  }

  @Bean
  JsonMapper jsonMapper() {
    return Json.mapper();
  }
}
