package io.browserskills.api;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.time.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.*;
import org.springframework.security.authentication.*;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.security.web.authentication.session.ChangeSessionIdAuthenticationStrategy;
import org.springframework.security.web.authentication.session.SessionAuthenticationStrategy;
import org.springframework.security.web.context.*;
import tools.jackson.databind.json.JsonMapper;

@Configuration
public class SecurityConfiguration {
  @Bean
  PasswordEncoder passwordEncoder() {
    return new BCryptPasswordEncoder(12);
  }

  @Bean
  UserDetailsService users(Store store) {
    return login -> {
      var user = store.findLogin(login);
      if (user == null) throw new UsernameNotFoundException("Invalid credentials");
      return User.withUsername(user.id().toString())
          .password(user.passwordHash())
          .disabled(!user.enabled())
          .authorities("USER")
          .build();
    };
  }

  @Bean
  AuthenticationManager authenticationManager(UserDetailsService users, PasswordEncoder encoder) {
    var provider = new DaoAuthenticationProvider(users);
    provider.setPasswordEncoder(encoder);
    return new ProviderManager(provider);
  }

  @Bean
  SecurityContextRepository contextRepository() {
    return new HttpSessionSecurityContextRepository();
  }

  @Bean
  org.springframework.security.web.csrf.CsrfTokenRepository csrfTokens() {
    return new org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository();
  }

  @Bean
  SessionAuthenticationStrategy sessionStrategy(
      org.springframework.security.web.csrf.CsrfTokenRepository tokens) {
    return new org.springframework.security.web.authentication.session
        .CompositeSessionAuthenticationStrategy(
        java.util.List.of(
            new ChangeSessionIdAuthenticationStrategy(),
            new org.springframework.security.web.csrf.CsrfAuthenticationStrategy(tokens)));
  }

  @Bean
  @ConditionalOnWebApplication
  SecurityFilterChain chain(
      HttpSecurity http,
      SecurityContextRepository contexts,
      Store store,
      ManualLeases leases,
      Clock clock,
      JsonMapper json,
      org.springframework.security.web.csrf.CsrfTokenRepository tokens)
      throws Exception {
    http.csrf(c -> c.csrfTokenRepository(tokens))
        .securityContext(c -> c.securityContextRepository(contexts))
        .sessionManagement(c -> c.sessionFixation(f -> f.changeSessionId()))
        .authorizeHttpRequests(
            c ->
                c.requestMatchers(
                        "/api/auth/csrf", "/api/auth/login", "/health/live", "/health/ready")
                    .permitAll()
                    .requestMatchers("/api/**")
                    .authenticated()
                    .anyRequest()
                    .permitAll())
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
                c.authenticationEntryPoint(
                        (req, res, e) ->
                            error(res, 401, "UNAUTHORIZED", "Authentication required.", json))
                    .accessDeniedHandler(
                        (req, res, e) ->
                            error(
                                res,
                                403,
                                "FORBIDDEN",
                                "Request is not authorized or CSRF token is missing.",
                                json)))
        .addFilterBefore(new SessionGuard(store, leases, clock, json), AuthorizationFilter.class);
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
