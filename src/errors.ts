export class DomainError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export function invariant(condition: unknown, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) throw new DomainError(code, message, details);
}
