import { Request, Response, NextFunction } from "express";
import * as userModel from "../models/User.js";
import { verifyToken } from "../utils/token.js";
import { handleError } from "../utils/errorHandler.js";
import { AppError } from "../errors/AppError.js";

// Who is making the request. Filled in by authenticate.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; role: "admin" | "viewer"; isLimited: boolean };
    }
  }
}

/**
 * Require "Authorization: Bearer <token>". The user is loaded from the
 * database on every request, so a deleted, declined or demoted user loses
 * access at once.
 */
export async function authenticate<P>(
  req: Request<P>,
  res: Response,
  next: NextFunction,
) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer "))
      throw new AppError(401, "unauthenticated", "Log in first");

    const userId = verifyToken(header.slice(7));
    let user;
    try {
      user = await userModel.getUserById(userId);
    } catch {
      throw new AppError(401, "invalid_token", "The account no longer exists");
    }
    if (user.status !== "active")
      throw new AppError(
        403,
        "account_not_active",
        "This account is not active",
      );

    req.auth = {
      userId: String(user._id),
      role: user.role,
      isLimited: !!user.isLimited,
    };
    next();
  } catch (err) {
    handleError(err, res);
  }
}

/** Only global admins pass. Use after authenticate. */
export function requireAdmin<P>(
  req: Request<P>,
  res: Response,
  next: NextFunction,
) {
  if (req.auth?.role !== "admin")
    return handleError(
      new AppError(403, "forbidden", "Only an admin can do this"),
      res,
    );
  next();
}
