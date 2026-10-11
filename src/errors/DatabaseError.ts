import { AppError } from "./AppError.js";

// 500: something went wrong when talking to the database
export class DatabaseError extends AppError {
  constructor(message: string) {
    super(500, "database_error", message);
    this.name = "DatabaseError";
  }
}
