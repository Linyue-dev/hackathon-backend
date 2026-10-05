import { InvalidInputError } from "../errors/InvalidInputError.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Check whether a string is a valid email address.
 * @param email The email to validate.
 * @returns true if valid, false otherwise.
 */
export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

/**
 * Normalize an email for storage and lookup (trim + lowercase).
 * Use this wherever an email is saved or compared, so "A@x.com" and "a@x.com" match.
 * @param email The raw email.
 * @returns the normalized email.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Copy only the allowed fields from an object. Everything else (e.g. _id, createdAt) is dropped.
 */
export function pickFields<T extends object>(
  source: Partial<T>,
  allowedFields: readonly (keyof T)[],
): Partial<T> {
  return Object.fromEntries(
    allowedFields
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]]),
  ) as Partial<T>;
}

/**
 * Convert an ISO string, number or Date to a Date.
 * Returns undefined for null/undefined, throws if the value is not a valid date.
 */
export function toDate(value: unknown): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const date = new Date(value as string | number | Date);
  if (isNaN(date.getTime()))
    throw new InvalidInputError(
      `Invalid input: '${String(value)}' is not a valid date`,
    );
  return date;
}
