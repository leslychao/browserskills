package io.browserskills.api;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice
public class ApiErrors {
  @ExceptionHandler(ApiException.class)
  ResponseEntity<Contracts.ApiError> known(ApiException e) {
    return ResponseEntity.status(e.status())
        .header("Cache-Control", "no-store")
        .body(new Contracts.ApiError(e.code(), e.getMessage()));
  }

  @ExceptionHandler({
    org.springframework.http.converter.HttpMessageNotReadableException.class,
    org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class
  })
  ResponseEntity<Contracts.ApiError> invalid(Exception e) {
    return known(ApiException.invalid());
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<Contracts.ApiError> unexpected(Exception e) {
    return ResponseEntity.internalServerError()
        .header("Cache-Control", "no-store")
        .body(new Contracts.ApiError("INTERNAL_ERROR", "Operation could not be completed."));
  }
}
