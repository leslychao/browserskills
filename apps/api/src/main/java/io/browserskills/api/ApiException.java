package io.browserskills.api;

public final class ApiException extends RuntimeException {
  private final int status;
  private final String code;

  public ApiException(int status, String code, String message) {
    super(message);
    this.status = status;
    this.code = code;
  }

  public int status() {
    return status;
  }

  public String code() {
    return code;
  }

  public static ApiException invalid() {
    return new ApiException(
        400, "INVALID_REQUEST", "Request does not match the supported task format.");
  }
}
