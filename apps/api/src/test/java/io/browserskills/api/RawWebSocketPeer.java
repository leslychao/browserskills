package io.browserskills.api;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

final class RawWebSocketPeer implements AutoCloseable {
  final ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
  final CompletableFuture<String> authorization = new CompletableFuture<>();
  final CompletableFuture<byte[]> input = new CompletableFuture<>();
  final ExecutorService executor = Executors.newSingleThreadExecutor();
  volatile Socket socket;

  RawWebSocketPeer() throws IOException {
    executor.execute(
        () -> {
          try {
            socket = server.accept();
            socket.setSoTimeout(10000);
            var in = socket.getInputStream();
            var out = socket.getOutputStream();
            var header = new ByteArrayOutputStream();
            while (header.size() < 8192) {
              int b = in.read();
              if (b < 0) throw new EOFException();
              header.write(b);
              if (header.toString(StandardCharsets.ISO_8859_1).endsWith("\r\n\r\n")) break;
            }
            String request = header.toString(StandardCharsets.ISO_8859_1);
            String key =
                Arrays.stream(request.split("\r\n"))
                    .filter(line -> line.toLowerCase(Locale.ROOT).startsWith("sec-websocket-key:"))
                    .findFirst()
                    .orElseThrow()
                    .split(":", 2)[1]
                    .strip();
            authorization.complete(
                Arrays.stream(request.split("\r\n"))
                    .filter(line -> line.toLowerCase(Locale.ROOT).startsWith("authorization:"))
                    .findFirst()
                    .orElseThrow()
                    .split(":", 2)[1]
                    .strip());
            String accept =
                Base64.getEncoder()
                    .encodeToString(
                        MessageDigest.getInstance("SHA-1")
                            .digest(
                                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
                                    .getBytes(StandardCharsets.ISO_8859_1)));
            out.write(
                ("HTTP/1.1 101 Switching Protocols\r\n"
                     + "Upgrade: websocket\r\n"
                     + "Connection: Upgrade\r\n"
                     + "Sec-WebSocket-Accept: "
                        + accept
                        + "\r\nSec-WebSocket-Protocol: binary\r\n\r\n")
                    .getBytes(StandardCharsets.ISO_8859_1));
            out.write(new byte[] {(byte) 0x82, 12});
            out.write("RFB 003.008\n".getBytes(StandardCharsets.US_ASCII));
            out.flush();
            int opcode = in.read(), length = in.read();
            if (opcode < 0 || length < 0) throw new EOFException();
            boolean mask = (length & 128) != 0;
            int size = length & 127;
            if (size >= 126) throw new IllegalArgumentException();
            byte[] masking = mask ? in.readNBytes(4) : new byte[4];
            byte[] payload = in.readNBytes(size);
            for (int i = 0; i < payload.length; i++) if (mask) payload[i] ^= masking[i % 4];
            input.complete(payload);
            while (in.read() != -1) {}
          } catch (Exception e) {
            authorization.completeExceptionally(e);
            input.completeExceptionally(e);
          }
        });
  }

  URI uri() {
    return URI.create("http://127.0.0.1:" + server.getLocalPort() + "/internal/view");
  }

  public void close() throws Exception {
    if (socket != null) socket.close();
    server.close();
    executor.shutdownNow();
  }
}
