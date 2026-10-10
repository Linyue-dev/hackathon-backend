import type { Response } from "express";
import { InvalidInputError } from "../errors/InvalidInputError.js";

export function handleError(err: unknown, res: Response) {
  if (err instanceof InvalidInputError) {
    res.status(400).json({ error: err.message });
    return;
  }

  // Server-side errors: log the details so they show up in the terminal
  console.error(err);

  if (err instanceof Error) {
    res.status(500).json({ error: err.message });
  } else {
    res.status(500).json({ error: "Unknown error" });
  }
}
