export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: number | string) {
    super(`${resource} with id ${id} not found`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`Validation failed: ${errors.join(', ')}`, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}
