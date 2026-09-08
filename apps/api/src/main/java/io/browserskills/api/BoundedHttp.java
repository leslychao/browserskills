package io.browserskills.api;

import java.io.ByteArrayOutputStream;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;

public final class BoundedHttp {
  private final HttpClient client =
      HttpClient.newBuilder()
          .version(HttpClient.Version.HTTP_1_1)
          .connectTimeout(Duration.ofSeconds(5))
          .followRedirects(HttpClient.Redirect.NEVER)
          .build();

  public HttpClient client() {
    return client;
  }

  public HttpResponse<byte[]> send(HttpRequest request, int limit, Duration timeout) {
    var future = client.sendAsync(request, ignored -> new Subscriber(limit));
    try {
      return future.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
    } catch (InterruptedException e) {
      future.cancel(true);
      Thread.currentThread().interrupt();
      throw new ApiException(503, "REQUEST_INTERRUPTED", "The request was interrupted.");
    } catch (Exception e) {
      future.cancel(true);
      throw new ApiException(
          502,
          "UPSTREAM_UNAVAILABLE",
          "The private service did not return a bounded response in time.");
    }
  }

  static final class Subscriber implements HttpResponse.BodySubscriber<byte[]> {
    private final int limit;
    private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    private final CompletableFuture<byte[]> result = new CompletableFuture<>();
    private Flow.Subscription subscription;

    Subscriber(int limit) {
      this.limit = limit;
    }

    public CompletionStage<byte[]> getBody() {
      return result;
    }

    public void onSubscribe(Flow.Subscription s) {
      subscription = s;
      s.request(1);
    }

    public void onNext(List<ByteBuffer> buffers) {
      for (var b : buffers) {
        if ((long) bytes.size() + b.remaining() > limit) {
          subscription.cancel();
          result.completeExceptionally(new IllegalArgumentException("Response too large"));
          return;
        }
        byte[] part = new byte[b.remaining()];
        b.get(part);
        bytes.writeBytes(part);
      }
      subscription.request(1);
    }

    public void onError(Throwable error) {
      result.completeExceptionally(new IllegalStateException("Private service failed"));
    }

    public void onComplete() {
      result.complete(bytes.toByteArray());
    }
  }
}
