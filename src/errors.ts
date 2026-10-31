const MAX_ERROR_TEXT = 4096;

/** The message of a thrown value, bounded, for replies and log lines. */
export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_TEXT);
}

/** An `Error` for a thrown value that is not one, so that it can be rejected or rethrown as an `Error`. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(errorText(value), { cause: value });
}

/**
 * A failure that a helper process reported with the Linux errno of the operation it performed. The file
 * system adapter turns it into the same Emscripten errno as a failure of a host operation.
 */
export class HelperError extends Error {
  readonly errno: number;

  constructor(message: string, errno: number) {
    super(message);
    this.name = "HelperError";
    this.errno = errno;
  }
}
