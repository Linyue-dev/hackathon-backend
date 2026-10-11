import type { Response } from "express";
import { AppError } from "../errors/AppError.js";
/**
 * Send every error as { code, message, details }.
 */
export function handleError(err: unknown, res: Response) {
  if (err instanceof AppError) {
    // Server-side errors: log the details so they show up in the terminal
    if (err.status >= 500) console.error(err);
    res.status(err.status).json({
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }

  // Anything else is an unexpected server error
  console.error(err);

  res.status(500).json({
    code: "server_error",
    message: err instanceof Error ? err.message : "Unknown error",
    details: null,
  });
}
