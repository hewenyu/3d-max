export class DomainError extends Error {
  constructor(
    message: string,
    public code = 'DOMAIN_ERROR',
    public status = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
