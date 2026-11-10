import { Request, Response, NextFunction } from "express";
import * as eventModel from "../models/Event.js";
import * as teamModel from "../models/Team.js";
import * as awardModel from "../models/Award.js";
import * as judgingAssignmentModel from "../models/JudgingAssignment.js";
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

// Finds the id of the event a request is about
type EventIdResolver = (ctx: {
  params: Record<string, string>;
}) => Promise<string> | string;

/**
 * Require at least this level in the event that getEventId points to.
 * Use after authenticate.
 */
export function authorizeVia(
  required: EventLevel,
  getEventId: EventIdResolver,
) {
  return async function <P>(
    req: Request<P>,
    res: Response,
    next: NextFunction,
  ) {
    try {
      if (!req.auth) throw new AppError(401, "unauthenticated", "Log in first");
      const params = req.params as unknown as Record<string, string>;
      const event = await eventModel.getEventById(await getEventId({ params }));
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

/** The event id is in the path (:id, or the named parameter). */
export function authorize(required: EventLevel, param = "id") {
  return authorizeVia(required, ({ params }) => params[param] ?? "");
}

/** The path has a team id; the event is the team's event. */
export function authorizeByTeam(required: EventLevel, param = "id") {
  return authorizeVia(
    required,
    async ({ params }) =>
      (await teamModel.getTeamById(params[param] ?? "")).eventId,
  );
}

/** The path has an award id; the event is the award's event. */
export function authorizeByAward(required: EventLevel, param = "id") {
  return authorizeVia(
    required,
    async ({ params }) =>
      (await awardModel.getAwardById(params[param] ?? "")).eventId,
  );
}

/** The path has an assignment id; the event is the assignment's event. */
export function authorizeByAssignment(required: EventLevel, param = "id") {
  return authorizeVia(
    required,
    async ({ params }) =>
      (
        await judgingAssignmentModel.getJudgingAssignmentById(
          params[param] ?? "",
        )
      ).eventId,
  );
}

/**
 * For the shared judge directory, which belongs to no single event: an admin,
 * or a user who is an owner or organizer of at least one event.
 * Use after authenticate.
 */
export async function requireOrganizerSomewhere<P>(
  req: Request<P>,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth) throw new AppError(401, "unauthenticated", "Log in first");
    if (req.auth.role !== "admin") {
      const events = await eventModel.getEventsOfUser(req.auth.userId);
      if (events.length === 0)
        throw new AppError(
          403,
          "forbidden",
          "This needs organizer rights in at least one event",
        );
    }
    next();
  } catch (err) {
    handleError(err, res);
  }
}
