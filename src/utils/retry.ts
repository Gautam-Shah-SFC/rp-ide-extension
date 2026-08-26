/** Throw this to signal a failure that retrying can't fix (e.g. missing config, expired auth). */
export class NonRetryableError extends Error {}
