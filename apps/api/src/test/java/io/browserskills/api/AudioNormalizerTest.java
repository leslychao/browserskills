package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import java.io.*;
import java.nio.*;
import javax.sound.sampled.*;
import org.junit.jupiter.api.Test;

class AudioNormalizerTest {
  @Test
  void realFfmpegPreservesDurationSilenceAndOriginalWhileConvertingForInference() throws Exception {
    var format = new AudioFormat(44100, 16, 2, true, false);
    var pcm = ByteBuffer.allocate(44100 * 4).order(ByteOrder.LITTLE_ENDIAN);
    for (int frame = 0; frame < 44100; frame++) {
      short value = frame < 8820 ? 0 : (short) (5000 * Math.sin(frame * 2 * Math.PI * 440 / 44100));
      pcm.putShort(value).putShort(value);
    }
    var originalOut = new ByteArrayOutputStream();
    try (var stream = new AudioInputStream(new ByteArrayInputStream(pcm.array()), format, 44100)) {
      AudioSystem.write(stream, AudioFileFormat.Type.WAVE, originalOut);
    }
    byte[] original = originalOut.toByteArray();
    String originalHash = SnapshotValidation.sha256(original);
    byte[] normalized = new AudioNormalizer().wav(original, 1000);
    assertEquals(originalHash, SnapshotValidation.sha256(original));
    try (var stream = AudioSystem.getAudioInputStream(new ByteArrayInputStream(normalized))) {
      assertEquals(16000, stream.getFormat().getSampleRate());
      assertEquals(1, stream.getFormat().getChannels());
      assertEquals(16, stream.getFormat().getSampleSizeInBits());
      assertEquals(16000, stream.getFrameLength());
      byte[] samples = stream.readAllBytes();
      for (int i = 0; i < 3000; i++)
        assertEquals(0, samples[i], "Leading silence must be preserved");
      assertTrue(
          java.util.stream.IntStream.range(8000, samples.length).anyMatch(i -> samples[i] != 0));
    }
    assertEquals(
        "AUDIO_UNAVAILABLE",
        assertThrows(
                ApiException.class, () -> new AudioNormalizer().wav("not audio".getBytes(), 1000))
            .code());
  }
}
