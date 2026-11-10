import { Request, Response, NextFunction } from "express";
import * as eventModel from "../models/Event.js";
import { handleError } from "../utils/errorHandler.js";
import { AppError } from "../errors/AppError.js";

export type EventLevel = "viewer" | "organizer" | "owner";
const RANK: Record<EventLevel, number> = { viewer: 1, organizer: 2, owner: 3 };

/**
 * What a user can do inside one event. A global admin has the owner rights in
 * every event. Anyone who is not limited and not on the lists is a viewer.
 * A limited (judge / mentor) account gets nothing here: it has its own checks.
 */
export function getEventLevel(
  auth: { userId: string; role: string; isLimited: boolean },
  event: { owners?: string[]; organizers?: string[] },
): EventLevel | null {
  if (auth.role === "admin") return "owner";
  if (event.owners?.includes(auth.userId)) return "owner";
  if (event.organizers?.includes(auth.userId)) return "organizer";
  if (!auth.isLimited) return "viewer";
  return null;
}

/**
 * Require at least this level in the event named by :id in the path.
 * Use after authenticate.
 */
export function authorize(required: EventLevel) {
  return async function <P>(
    req: Request<P>,
    res: Response,
    next: NextFunction,
  ) {
    try {
      if (!req.auth) throw new AppError(401, "unauthenticated", "Log in first");
      const eventId = (req.params as unknown as { id?: string }).id ?? "";
      const event = await eventModel.getEventById(eventId);
      const level = getEventLevel(req.auth, event);
      if (!level || RANK[level] < RANK[required])
        throw new AppError(
          403,
          "forbidden",
          `This needs ${required} rights in this event`,
        );
      next();
    } catch (err) {
      handleError(err, res);
    }
  };
}
