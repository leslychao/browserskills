package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

class MediaRangesTest {
  @Test
  void fullPartialSuffixAndUnsatisfiableRanges() {
    byte[] bytes = new byte[] {0, 1, 2, 3, 4};
    var full = MediaRanges.response(bytes, "audio/wav", null);
    assertEquals(200, full.getStatusCode().value());
    assertEquals("no-store", full.getHeaders().getCacheControl());
    assertArrayEquals(
        new byte[] {1, 2}, MediaRanges.response(bytes, "audio/wav", "bytes=1-2").getBody());
    assertArrayEquals(
        new byte[] {3, 4}, MediaRanges.response(bytes, "audio/wav", "bytes=-2").getBody());
    assertArrayEquals(
        new byte[] {4}, MediaRanges.response(bytes, "audio/wav", "bytes=4-").getBody());
    for (String bad :
        new String[] {
          "bytes=99-",
          "bytes=2-1",
          "bytes=-0",
          "bytes=1-2,4-5",
          "abc",
          "bytes=-",
          "bytes=99999999999999999999999-"
        }) assertEquals(416, MediaRanges.response(bytes, "audio/wav", bad).getStatusCode().value());
  }
}
