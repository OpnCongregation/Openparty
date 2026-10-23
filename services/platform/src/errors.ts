export class DomainError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly details?: unknown) {
    super(message);
  }
}
export const fail = (code: string, message: string, status = 400, details?: unknown): never => {
  throw new DomainError(code, message, status, details);
};
