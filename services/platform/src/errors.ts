export class DomainError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}
export const fail = (code: string, message: string, status = 400): never => {
  throw new DomainError(code, message, status);
};
