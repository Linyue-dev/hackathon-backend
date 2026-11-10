import { Request, Response, NextFunction } from "express";
import * as eventModel from "../models/Event.js";
import * as teamModel from "../models/Team.js";
import * as awardModel from "../models/Award.js";
import * as judgeModel from "../models/Judge.js";
import * as judgingAssignmentModel from "../models/JudgingAssignment.js";
import { handleError } from "../utils/errorHandler.js";
import { AppError } from "../errors/AppError.js";

export type EventLevel = "viewer" | "organizer" | "owner";
const RANK: Record<EventLevel, number> = { viewer: 1, organizer: 2, owner: 3 };

/**
 * What a user can do inside one event. A global admin has the owner rights in
 * every event. Anyone else who is logged in is a viewer: they can read but not change.
 */
export function getEventLevel(
  auth: { userId: string; role: string; isLimited: boolean },
  event: { owners?: string[]; organizers?: string[] },
): EventLevel | null {
  if (auth.role === "admin") return "owner";
  if (event.owners?.includes(auth.userId)) return "owner";
  if (event.organizers?.includes(auth.userId)) return "organizer";
  return "viewer";
}

// Finds the id of the event a request is about
type EventIdResolver = (ctx: {
  params: Record<string, string>;
  query: Request["query"];
}) => Promise<string> | string;

//#region Where the event id comes from

/** The event id is in the path (:id, or the named parameter). */
export const eventFromParam =
  (param = "id"): EventIdResolver =>
  ({ params }) =>
    params[param] ?? "";

/** The event id is in the ?eventId= query parameter. */
export const eventFromQuery: EventIdResolver = ({ query }) =>
  typeof query.eventId === "string" ? query.eventId : "";

/** The path has a team id; the event is the team's event. */
export const eventFromTeam =
  (param = "id"): EventIdResolver =>
  async ({ params }) =>
    (await teamModel.getTeamById(params[param] ?? "")).eventId;

/** The path has an award id; the event is the award's event. */
export const eventFromAward =
  (param = "id"): EventIdResolver =>
  async ({ params }) =>
    (await awardModel.getAwardById(params[param] ?? "")).eventId;

/** The path has an assignment id; the event is the assignment's event. */
export const eventFromAssignment =
  (param = "id"): EventIdResolver =>
  async ({ params }) =>
    (await judgingAssignmentModel.getJudgingAssignmentById(params[param] ?? ""))
      .eventId;

//#endregion

function getContext<P>(req: Request<P>) {
  return {
    params: req.params as unknown as Record<string, string>,
    query: req.query,
  };
}

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
      const event = await eventModel.getEventById(
        await getEventId(getContext(req)),
      );
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
  return authorizeVia(required, eventFromParam(param));
}

export function authorizeByTeam(required: EventLevel, param = "id") {
  return authorizeVia(required, eventFromTeam(param));
}

export function authorizeByAward(required: EventLevel, param = "id") {
  return authorizeVia(required, eventFromAward(param));
}

export function authorizeByAssignment(required: EventLevel, param = "id") {
  return authorizeVia(required, eventFromAssignment(param));
}

/**
 * For the routes with :judgeId that a judge uses. Passes for an admin, for the
 * judge whose login account is the caller, and for an organizer or owner of
 * the event. Use after authenticate.
 */
export function authorizeJudge(getEventId: EventIdResolver) {
  return async function <P>(
    req: Request<P>,
    res: Response,
    next: NextFunction,
  ) {
    try {
      if (!req.auth) throw new AppError(401, "unauthenticated", "Log in first");
      if (req.auth.role === "admin") return next();

      const ctx = getContext(req);
      const judge = await judgeModel.getJudgeById(ctx.params.judgeId ?? "");
      if (judge.userId && judge.userId === req.auth.userId) return next();

      const event = await eventModel.getEventById(await getEventId(ctx));
      const level = getEventLevel(req.auth, event);
      if (level && RANK[level] >= RANK.organizer) return next();

      throw new AppError(
        403,
        "forbidden",
        "Only this judge or an organizer of the event can do this",
      );
    } catch (err) {
      handleError(err, res);
    }
  };
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
