import { AppError } from "./AppError.js";

// 400: the request data is not valid
export class InvalidInputError extends AppError {
  constructor(message: string, details: unknown = null) {
    super(400, "invalid_input", message, details);
    this.name = "InvalidInputError";
  }
}
