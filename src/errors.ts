/** Application-level error carrying an HTTP-style status code. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg: string) => new AppError(400, 'BAD_REQUEST', msg);
export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Insufficient permissions') =>
  new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg: string) => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);
export const immutable = (msg: string) => new AppError(409, 'IMMUTABLE_VERSION', msg);
