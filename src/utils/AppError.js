// Every error the API sends back on purpose: HTTP status + a fixed code the frontend can check + a message.
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** 400: the data has the wrong shape (bad email, text instead of a number, unknown field). */
  static validation(details) {
    return new AppError(400, 'VALIDATION_FAILED', 'Validation failed', details);
  }

  /** 401: not logged in, or the token is wrong / expired. */
  static unauthorized(message = 'Not signed in') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  /** 403: logged in, but not allowed to do this. */
  static forbidden(message = 'Not allowed') {
    return new AppError(403, 'FORBIDDEN', message);
  }

  /** 404: the record does not exist (or belongs to another company). */
  static notFound(what) {
    return new AppError(404, 'NOT_FOUND', `${what} not found`);
  }

  /** 422: the data is fine but breaks a business rule (e.g. more meters than the lot has). */
  static rule(code, message, details) {
    return new AppError(422, code, message, details);
  }
}

module.exports = AppError;
