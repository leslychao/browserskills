package io.browserskills.api;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.time.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import tools.jackson.databind.json.JsonMapper;

@Configuration
public class SecurityConfiguration {
  @Bean
  PasswordEncoder passwordEncoder() {
    return new BCryptPasswordEncoder(12);
  }

  @Bean
  org.springframework.security.web.csrf.CsrfTokenRepository csrfTokens() {
    return new org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository();
  }

  @Bean
  @ConditionalOnWebApplication
  SecurityFilterChain chain(
      HttpSecurity http,
      JsonMapper json,
      org.springframework.security.web.csrf.CsrfTokenRepository tokens)
      throws Exception {
    http.csrf(c -> c.csrfTokenRepository(tokens))
        .securityContext(c -> c.disable())
        .sessionManagement(c -> c.sessionFixation(f -> f.changeSessionId()))
        .authorizeHttpRequests(c -> c.anyRequest().permitAll())
        .formLogin(c -> c.disable())
        .httpBasic(c -> c.disable())
        .logout(c -> c.disable())
        .requestCache(c -> c.disable())
        .headers(
            c ->
                c.contentSecurityPolicy(
                    p ->
                        p.policyDirectives(
                            "default-src 'self'; script-src 'self'; style-src 'self'"
                                + " 'unsafe-inline'; img-src 'self' data:; media-src 'self';"
                                + " connect-src 'self'; frame-ancestors 'none'; base-uri 'none';"
                                + " object-src 'none'")))
        .exceptionHandling(
            c ->
                c.accessDeniedHandler(
                    (req, res, e) ->
                        error(res, 403, "FORBIDDEN", "CSRF token is missing or invalid.", json)))
        .addFilterBefore(new RequestBodyLimit(json), AuthorizationFilter.class);
    return http.build();
  }

  static void error(
      HttpServletResponse response, int status, String code, String message, JsonMapper json)
      throws IOException {
    response.setStatus(status);
    response.setContentType("application/json");
    response.setHeader("Cache-Control", "no-store");
    response.getOutputStream().write(json.writeValueAsBytes(new Contracts.ApiError(code, message)));
  }
}
