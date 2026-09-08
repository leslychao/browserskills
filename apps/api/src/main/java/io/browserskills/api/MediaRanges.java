package io.browserskills.api;

import java.util.Arrays;
import org.springframework.http.*;

public final class MediaRanges {
  private MediaRanges() {}

  public static ResponseEntity<byte[]> response(byte[] data, String mime, String range) {
    var headers = new HttpHeaders();
    headers.setContentType(MediaType.parseMediaType(mime));
    headers.setCacheControl("no-store");
    headers.set("Accept-Ranges", "bytes");
    headers.set("X-Content-Type-Options", "nosniff");
    if (range == null) {
      headers.setContentLength(data.length);
      return new ResponseEntity<>(data, headers, HttpStatus.OK);
    }
    try {
      if (!range.matches("bytes=\\d*-\\d*")) throw new IllegalArgumentException();
      String[] parts = range.substring(6).split("-", -1);
      long start, end;
      if (parts[0].isEmpty()) {
        long suffix = Long.parseLong(parts[1]);
        if (suffix <= 0) throw new IllegalArgumentException();
        start = Math.max(0, data.length - suffix);
        end = data.length - 1;
      } else {
        start = Long.parseLong(parts[0]);
        end =
            parts[1].isEmpty()
                ? data.length - 1
                : Math.min(Long.parseLong(parts[1]), data.length - 1);
      }
      if (start < 0 || start >= data.length || end < start) throw new IllegalArgumentException();
      headers.set("Content-Range", "bytes " + start + "-" + end + "/" + data.length);
      headers.setContentLength(end - start + 1);
      return new ResponseEntity<>(
          Arrays.copyOfRange(data, (int) start, (int) end + 1),
          headers,
          HttpStatus.PARTIAL_CONTENT);
    } catch (Exception e) {
      headers.set("Content-Range", "bytes */" + data.length);
      return new ResponseEntity<>(new byte[0], headers, HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
    }
  }
}
