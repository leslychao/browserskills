package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import java.io.ByteArrayInputStream;
import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.security.crypto.password.PasswordEncoder;

class AccountCliTest {
  @Test
  void provisionsFromStdinAndDisablesWithoutPasswordArguments() throws Exception {
    var store = mock(Store.class);
    var encoder = mock(PasswordEncoder.class);
    var context = mock(ConfigurableApplicationContext.class);
    when(encoder.encode("secure-password")).thenReturn("hash");
    var cli = new AccountCli(store, encoder, context);
    var stdin = System.in;
    try {
      System.setIn(new ByteArrayInputStream("secure-password\n".getBytes()));
      cli.run(new DefaultApplicationArguments("--create-user=alice"));
      verify(store).provision("alice", "hash");
      verify(context).close();
      when(store.disable("alice")).thenReturn(true);
      cli.run(new DefaultApplicationArguments("--disable-user=alice"));
      assertThrows(
          IllegalArgumentException.class, () -> cli.run(new DefaultApplicationArguments()));
      assertThrows(
          IllegalArgumentException.class,
          () -> cli.run(new DefaultApplicationArguments("--disable-user=missing")));
      System.setIn(new ByteArrayInputStream("short\n".getBytes()));
      assertThrows(
          IllegalArgumentException.class,
          () -> cli.run(new DefaultApplicationArguments("--create-user=bob")));
    } finally {
      System.setIn(stdin);
    }
  }
}
