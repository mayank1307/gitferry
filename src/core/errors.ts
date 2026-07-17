/** Error with an optional user-facing hint on how to proceed. */
export class GitFerryError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "GitFerryError";
  }
}
