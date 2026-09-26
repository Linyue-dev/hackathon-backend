import type { Response } from "express";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { DatabaseError } from "../errors/DatabaseError.js";

export function handleError(err: unknown, res: Response) {
  if (err instanceof InvalidInputError) {
    res.status(400).json({ error: err.message });
  } else if (err instanceof DatabaseError) {
    res.status(500).json({ error: err.message });
  } else if (err instanceof Error) {
    res.status(500).json({ error: err.message });
  } else {
    res.status(500).json({ error: "Unknown error" });
  }
}
