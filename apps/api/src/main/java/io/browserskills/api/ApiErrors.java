package io.browserskills.api;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice
public class ApiErrors {
  @ExceptionHandler({
    org.springframework.web.servlet.resource.NoResourceFoundException.class,
    org.springframework.web.servlet.NoHandlerFoundException.class
  })
  ResponseEntity<Contracts.ApiError> notFound(Exception e) {
    return known(new ApiException(404, "NOT_FOUND", "Resource not found."));
  }

  @ExceptionHandler(ApiException.class)
  ResponseEntity<Contracts.ApiError> known(ApiException e) {
    return ResponseEntity.status(e.status())
        .header("Cache-Control", "no-store")
        .body(new Contracts.ApiError(e.code(), message(e.code())));
  }

  static String message(String code) {
    return switch (code) {
      case "QUALITY_NOT_VERIFIED" -> "Качество модели для этого вида заданий ещё не подтверждено.";
      case "UNSUPPORTED_IDENTITY_TASK" ->
          "Задания на идентификацию людей по изображениям не поддерживаются.";
      case "YANG_LOGIN_REQUIRED", "LOGIN_REQUIRED", "AUTH_EXPIRED" ->
          "Войдите в Янг в серверном браузере, затем продолжите запуск.";
      case "TWO_FACTOR_REQUIRED" -> "Введите одноразовый код в серверном браузере.";
      case "AI_QUOTA" -> "Дневной лимит запросов к модели исчерпан.";
      case "AI_BUSY", "AI_QUEUE_TIMEOUT" -> "Модель занята. Повторите запуск позже.";
      case "INSTRUCTION_INCOMPLETE", "INSTRUCTION_UNAVAILABLE" ->
          "Не удалось полностью прочитать инструкцию и примеры проекта.";
      case "INSTRUCTION_CONTEXT_UNSUPPORTED", "MODEL_CONTEXT_UNSUPPORTED", "MODEL_MATERIAL_LIMIT" ->
          "Материалы задания превышают доступные пределы локальной модели.";
      case "MODEL_ABSTAINED", "INVALID_MODEL_RESPONSE" ->
          "Модель не смогла дать однозначный проверяемый ответ.";
      case "MODEL_UNAVAILABLE", "AI_UNAVAILABLE", "MODEL_TIMEOUT" ->
          "Локальная модель недоступна или не завершила обработку вовремя.";
      case "ACTIVE_SUITE_UNSUPPORTED", "ACTIVE_SUITE_CONFLICT" ->
          "В браузере есть зарезервированный набор, не соответствующий условиям запуска.";
      case "PROJECT_REQUIRED" -> "Выберите проект или откройте текущий набор в серверном браузере.";
      case "NO_MATCHING_TASKS" -> "Нет доступных заданий, подходящих под условия запуска.";
      case "REWARD_UNITS_DIFFER" -> "Цены указаны в разных единицах. Выберите проект вручную.";
      case "UNMAPPED_CONTROLS", "UNSUPPORTED_TEMPLATE" ->
          "Форму этого задания пока нельзя заполнить автоматически.";
      case "TASK_EXPIRED" -> "Время выполнения набора истекло.";
      case "STALE_TASK", "SNAPSHOT_CHANGED", "INSTRUCTION_CHANGED", "FORM_UNSTABLE" ->
          "Содержимое задания изменилось во время обработки.";
      case "ANSWER_READBACK_FAILED" -> "Не удалось подтвердить значения заполненной формы.";
      case "UNRESOLVED_TASK", "SUBMIT_OUTCOME_UNKNOWN", "SUBMISSION_ALREADY_ATTEMPTED" ->
          "Результат отправки набора требует проверки в Янг; повторная отправка запрещена.";
      case "RUN_ACTIVE" -> "У вас уже есть активный запуск.";
      case "MANUAL_CONTROL_ACTIVE" ->
          "Завершите ручное управление перед обновлением каталога проектов.";
      case "CONTROL_IN_USE" ->
          "Браузер открыт в другой вкладке. Нажмите «Перехватить управление», чтобы продолжить здесь.";
      case "CONTROL_REQUIRED" ->
          "Ручное управление завершено или передано другой вкладке. Подключитесь снова.";
      case "RUN_NOT_PAUSED", "RUN_STOPPED" ->
          "Текущее состояние запуска не допускает это действие.";
      case "NOT_FOUND" -> "Ресурс не найден.";
      case "INVALID_REQUEST" -> "Проверьте параметры запроса.";
      case "IDEMPOTENCY_CONFLICT" ->
          "Этот идентификатор запроса уже использован с другими параметрами.";
      default -> "Операция не завершена. Проверьте состояние запуска и серверного браузера.";
    };
  }

  @ExceptionHandler({
    org.springframework.http.converter.HttpMessageNotReadableException.class,
    org.springframework.web.bind.MissingRequestHeaderException.class,
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
