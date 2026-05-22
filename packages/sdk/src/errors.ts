/** The set of error conditions every SDK method may surface. */
export type RapportErrorCode =
  | "unauthorized"
  | "not_found"
  | "invalid_request"
  | "network_error"
  | "verification_failed";

/** The single error type thrown by every `Rapport` method. */
export class RapportError extends Error {
  /** A stable, machine-readable cause. */
  readonly code: RapportErrorCode;
  /** The HTTP status, when the error came from an API response. */
  readonly status?: number;

  constructor(code: RapportErrorCode, message: string, status?: number) {
    super(message);
    this.name = "RapportError";
    this.code = code;
    this.status = status;
  }
}
