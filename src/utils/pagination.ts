import { InvalidInputError } from "../errors/InvalidInputError.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Read ?page and ?limit from a query string. Defaults: page 1, limit 20 (max 100).
 */
export function parsePagination(page: unknown, limit: unknown): Pagination {
  const pageNumber = page === undefined ? 1 : Number(page);
  const limitNumber = limit === undefined ? DEFAULT_LIMIT : Number(limit);

  if (!Number.isInteger(pageNumber) || pageNumber < 1)
    throw new InvalidInputError(
      "Invalid input: page must be a whole number of 1 or more",
    );
  if (
    !Number.isInteger(limitNumber) ||
    limitNumber < 1 ||
    limitNumber > MAX_LIMIT
  )
    throw new InvalidInputError(
      `Invalid input: limit must be a whole number between 1 and ${MAX_LIMIT}`,
    );

  return {
    page: pageNumber,
    limit: limitNumber,
    skip: (pageNumber - 1) * limitNumber,
  };
}
