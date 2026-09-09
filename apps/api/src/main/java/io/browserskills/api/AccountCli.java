package io.browserskills.api;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.springframework.boot.*;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Profile;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

@Component
@Profile("admin")
public class AccountCli implements ApplicationRunner {
  private final Store store;
  private final PasswordEncoder passwords;
  private final ConfigurableApplicationContext context;

  public AccountCli(
      Store store, PasswordEncoder passwords, ConfigurableApplicationContext context) {
    this.store = store;
    this.passwords = passwords;
    this.context = context;
  }

  public void run(ApplicationArguments args) throws Exception {
    if (args.containsOption("create-user") == args.containsOption("disable-user"))
      throw new IllegalArgumentException("Specify exactly one account operation.");
    if (args.containsOption("disable-user")) {
      if (!store.disable(args.getOptionValues("disable-user").getFirst()))
        throw new IllegalArgumentException("Account not found.");
    } else {
      char[] password;
      if (System.console() != null) password = System.console().readPassword("Password: ");
      else {
        byte[] input = System.in.readNBytes(75);
        if (input.length > 74) throw new IllegalArgumentException("Password is too long.");
        String line =
            StandardCharsets.UTF_8
                .newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(input))
                .toString();
        if (line.endsWith("\n")) line = line.substring(0, line.length() - 1);
        if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
        password = line.toCharArray();
        Arrays.fill(input, (byte) 0);
      }
      try {
        String value = new String(password);
        int length = value.getBytes(StandardCharsets.UTF_8).length;
        if (length < 12 || length > 72)
          throw new IllegalArgumentException("Password must contain 12 to 72 UTF-8 bytes.");
        store.provision(args.getOptionValues("create-user").getFirst(), passwords.encode(value));
      } finally {
        Arrays.fill(password, '\0');
      }
    }
    System.out.println("Account operation completed.");
    context.close();
  }
}
