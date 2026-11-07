import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";

// Read when needed, so the .env file is already loaded
function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set in the environment");
  return secret;
}

/**
 * Sign a login token. It holds only the user id: the role and status are read
 * from the database on every request, so a demoted or deleted user loses
 * access at once.
 */
export function signToken(userId: string): string {
  return jwt.sign({ userId }, getSecret(), {
    expiresIn: "7d",
    algorithm: "HS256",
  });
}

/**
 * Check a login token and return the user id inside it.
 * Throws 401 when the token is missing its id, wrong, or expired.
 */
export function verifyToken(token: string): string {
  try {
    const payload = jwt.verify(token, getSecret(), { algorithms: ["HS256"] });
    if (typeof payload === "object" && typeof payload.userId === "string")
      return payload.userId;
  } catch {
    // fall through to the error below
  }
  throw new AppError(
    401,
    "invalid_token",
    "The token is invalid or has expired",
  );
}
