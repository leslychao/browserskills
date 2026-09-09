package io.browserskills.api;

import java.nio.file.*;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;

@Component
public class AudioNormalizer {
  public byte[] wav(byte[] original, long durationMs) {
    return wav(original, durationMs, Duration.ofSeconds(20));
  }

  public byte[] wav(byte[] original, long durationMs, Duration budget) {
    Path directory = null;
    Process process = null;
    try {
      directory = Files.createTempDirectory("browserskills-audio-");
      Path input = directory.resolve("original"), output = directory.resolve("inference.wav");
      Files.write(input, original);
      process =
          new ProcessBuilder(
                  "ffmpeg",
                  "-nostdin",
                  "-hide_banner",
                  "-loglevel",
                  "quiet",
                  "-protocol_whitelist",
                  "file,pipe",
                  "-format_whitelist",
                  "wav,mp3,ogg,matroska,webm,flac,mov,aac",
                  "-i",
                  input.toString(),
                  "-vn",
                  "-ac",
                  "1",
                  "-ar",
                  "16000",
                  "-c:a",
                  "pcm_s16le",
                  "-f",
                  "wav",
                  "-fs",
                  "4000001",
                  output.toString())
              .redirectOutput(ProcessBuilder.Redirect.DISCARD)
              .redirectError(ProcessBuilder.Redirect.DISCARD)
              .start();
      if (!process.waitFor(
          Math.min(20_000, Math.max(1, budget.toMillis())), TimeUnit.MILLISECONDS)) {
        process.destroyForcibly();
        process.waitFor(5, TimeUnit.SECONDS);
        throw new IllegalStateException();
      }
      if (process.exitValue() != 0 || !Files.exists(output)) throw new IllegalStateException();
      long size = Files.size(output);
      if (size < 44 || size > 4_000_000 || size > durationMs * 34 + 4096)
        throw new IllegalStateException();
      byte[] normalized = Files.readAllBytes(output);
      try (var stream =
          javax.sound.sampled.AudioSystem.getAudioInputStream(
              new java.io.ByteArrayInputStream(normalized))) {
        double actualMs = stream.getFrameLength() * 1000.0 / stream.getFormat().getSampleRate();
        if (Math.abs(actualMs - durationMs) > 200) throw new IllegalStateException();
      }
      return normalized;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new ApiException(502, "AUDIO_UNAVAILABLE", "Audio normalization was interrupted.");
    } catch (Exception e) {
      throw new ApiException(
          502, "AUDIO_UNAVAILABLE", "Audio cannot be normalized without modifying its duration.");
    } finally {
      if (process != null && process.isAlive()) {
        boolean interrupted = Thread.interrupted();
        process.destroyForcibly();
        try {
          process.waitFor(5, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
          interrupted = true;
        } finally {
          if (interrupted) Thread.currentThread().interrupt();
        }
      }
      if (directory != null) {
        try {
          Files.deleteIfExists(directory.resolve("original"));
          Files.deleteIfExists(directory.resolve("inference.wav"));
          Files.deleteIfExists(directory);
        } catch (Exception ignored) {
        }
      }
    }
  }
}
