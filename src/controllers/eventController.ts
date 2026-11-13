import express, { Request, Response } from "express";
import * as eventModel from "../models/Event.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";
import { parsePagination } from "../utils/pagination.js";
import * as judgingAssignmentModel from "../models/JudgingAssignment.js";
import * as resultModel from "../models/Result.js";
import {
  authenticate,
  requireAdmin,
  requireNotLimited,
} from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post("/events", authenticate, requireAdmin, createEvent);
router.get("/events", authenticate, requireNotLimited, getEvents);
router.get("/events/:id", authenticate, authorize("viewer"), getEventById);
router.patch("/events/:id", authenticate, authorize("owner"), updateEvent);
router.delete("/events/:id", authenticate, authorize("owner"), deleteEvent);

router.post(
  "/events/:id/judging/start",
  authenticate,
  authorize("organizer"),
  startJudging,
);
router.post(
  "/events/:id/judging/end",
  authenticate,
  authorize("organizer"),
  endJudging,
);

router.get(
  "/events/:id/summary",
  authenticate,
  authorize("organizer"),
  getEventSummary,
);

router.get("/events/:id/owners", authenticate, authorize("owner"), getOwners);
router.post("/events/:id/owners", authenticate, authorize("owner"), addOwner);
router.delete(
  "/events/:id/owners/:userId",
  authenticate,
  authorize("owner"),
  removeOwner,
);

router.get(
  "/events/:id/organizers",
  authenticate,
  authorize("owner"),
  getOrganizers,
);
router.post(
  "/events/:id/organizers",
  authenticate,
  authorize("owner"),
  addOrganizer,
);
router.delete(
  "/events/:id/organizers/:userId",
  authenticate,
  authorize("owner"),
  removeOrganizer,
);

// ============ Handlers ============

/**
 * POST /events
 * Create an event.
 * Body: name (required). Optional: status, theme, description,
 * address { street, city, province, postal }, rooms (list of strings),
 * arrivalNotes, logoUrl, venue, startDatetime, endDatetime.
 * Status values: draft, in-progress, judging-started, judging-ended, complete.
 * judgingStartedAt, judgingEndedAt and resultsPublishedAt are set by the
 * server and cannot be sent.
 * Returns 201 with the event.
 * Only an admin can create an event. It starts without owners: an admin names
 * them with POST /events/:id/owners.
 * Errors: 400 invalid input. 401 unauthenticated. 403 forbidden.
 */
async function createEvent(req: Request, res: Response) {
  try {
    const {
      name,
      status,
      theme,
      description,
      address,
      rooms,
      arrivalNotes,
      logoUrl,
      venue,
      startDatetime,
      endDatetime,
    } = req.body ?? {};
    const event = await eventModel.addEvent({
      name,
      status,
      theme,
      description,
      address,
      rooms,
      arrivalNotes,
      logoUrl,
      venue,
      startDatetime,
      endDatetime,
    });
    res.status(201).json(event);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events?status=&search=&page=&limit=
 * List events, newest first.
 * status: one event status (for example "judging-started") or one of the
 * dashboard groups "draft", "upcoming", "active", "past".
 * search matches the name (partial, not case-sensitive).
 * Returns 200 with a plain array. Each event also has teamCount (teams of the
 * event), judgeCount (judges added to the event) and progress (whole percent
 * of the judges' assignments that have submitted scores; 0 without assignments).
 */
async function getEvents(req: Request, res: Response) {
  try {
    const { status, search, page, limit } = req.query;
    const { events, total } = await eventModel.getAllEvents(
      {
        status: typeof status === "string" ? status : undefined,
        search: typeof search === "string" ? search : undefined,
      },
      parsePagination(page, limit),
    );
    const stats = await judgingAssignmentModel.getEventStats(
      events.map((e) => e._id.toString()),
    );
    res.set("X-Total-Count", String(total));
    res.json(events.map((e) => ({ ...e, ...stats.get(e._id.toString()) })));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id
 * One event.
 * Errors: 400 if the event does not exist.
 */
async function getEventById(req: Request<IdParams>, res: Response) {
  try {
    const event = await eventModel.getEventById(req.params.id);
    res.json(event);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /events/:id
 * Change some fields of an event. Send only the fields to change.
 * Allowed: name, theme, description, address, rooms, arrivalNotes, status,
 * logoUrl, venue, startDatetime, endDatetime.
 * status can only be set to "draft" or "in-progress" here. The judging
 * statuses are set by POST /events/:id/judging/start and /end.
 * Returns 200 with the updated event.
 * Errors: 400 invalid input, a field that cannot be updated, or event not found.
 */
async function updateEvent(req: Request<IdParams>, res: Response) {
  try {
    const event = await eventModel.updateEventById(
      req.params.id,
      req.body ?? {},
    );
    res.json(event);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /events/:id
 * Delete an event. Returns 200 with { message, event }.
 * Note: there is no check yet for teams, awards or scores that belong to the
 * event; the delete rules are still to be decided.
 * Errors: 400 if the event does not exist.
 */
async function deleteEvent(req: Request<IdParams>, res: Response) {
  try {
    const event = await eventModel.deleteEventById(req.params.id);
    res.json({ message: "Event deleted", event });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /events/:id/judging/start
 * Open judging: status becomes "judging-started" and judgingStartedAt is set.
 * No body. Allowed from "draft" or "in-progress". Judges can save scores
 * only while judging is started.
 * Returns 200 with the event.
 * Errors: 400 if judging was already started, ended, or the event is complete,
 * or the event does not exist.
 */
async function startJudging(req: Request<IdParams>, res: Response) {
  try {
    res.json(await eventModel.startJudging(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /events/:id/judging/end
 * Close judging: status becomes "judging-ended" and judgingEndedAt is set.
 * No body. Only allowed while the status is "judging-started". After this,
 * every write to scores is refused with 423 judging_closed.
 * Returns 200 with the event.
 * Errors: 400 if judging is not open, or the event does not exist.
 */
async function endJudging(req: Request<IdParams>, res: Response) {
  try {
    res.json(await eventModel.endJudging(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/summary
 * Dashboard numbers of the event, counted over its active teams. :id is the event id.
 * Returns 200 with { teams, graded, gradingNow, notStarted, avgScore }.
 * graded: teams with judges where every judge has submitted.
 * gradingNow: other teams where at least one judge has started or submitted.
 * notStarted: all the rest, including teams without judges.
 * avgScore: average total of the submitted scores; null when none are submitted.
 * Errors: 400 invalid_input - the event does not exist.
 */
async function getEventSummary(req: Request<IdParams>, res: Response) {
  try {
    res.json(await resultModel.getEventSummary(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

type MemberParams = { id: string; userId: string };

/**
 * GET /events/:id/owners
 * The owners of the event.
 * Who: an owner of the event, or an admin.
 * Returns 200 with a plain array of { userId, firstName, lastName, email }.
 * Errors: 400 if the event does not exist. 401 unauthenticated. 403 forbidden.
 */
async function getOwners(req: Request<IdParams>, res: Response) {
  try {
    res.json(await eventModel.getEventMembers(req.params.id, "owners"));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /events/:id/owners
 * Make a user an owner of the event. Body: userId (required).
 * Only an active account that is not a judge / mentor account can be added.
 * Adding someone who is already an owner changes nothing.
 * Who: an owner of the event, or an admin.
 * Returns 201 with the updated list of owners.
 * Errors: 400 invalid userId, unknown user, inactive or limited account, or
 * event not found. 401 unauthenticated. 403 forbidden.
 */
async function addOwner(req: Request<IdParams>, res: Response) {
  try {
    const members = await eventModel.addEventMember(
      req.params.id,
      "owners",
      req.body?.userId,
    );
    res.status(201).json(members);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /events/:id/owners/:userId
 * Remove a user from the owners of the event. Removing someone who is not an
 * owner changes nothing.
 * Who: an owner of the event, or an admin.
 * Returns 200 with the updated list of owners.
 * Errors: 400 if the event does not exist. 401 unauthenticated. 403 forbidden.
 */
async function removeOwner(req: Request<MemberParams>, res: Response) {
  try {
    res.json(
      await eventModel.removeEventMember(
        req.params.id,
        "owners",
        req.params.userId,
      ),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/organizers
 * The organizers of the event.
 * Who: an owner of the event, or an admin.
 * Returns 200 with a plain array of { userId, firstName, lastName, email }.
 * Errors: 400 if the event does not exist. 401 unauthenticated. 403 forbidden.
 */
async function getOrganizers(req: Request<IdParams>, res: Response) {
  try {
    res.json(await eventModel.getEventMembers(req.params.id, "organizers"));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /events/:id/organizers
 * Make a user an organizer of the event. Body: userId (required).
 * Only an active account that is not a judge / mentor account can be added.
 * Adding someone who is already an organizer changes nothing.
 * Who: an owner of the event, or an admin.
 * Returns 201 with the updated list of organizers.
 * Errors: 400 invalid userId, unknown user, inactive or limited account, or
 * event not found. 401 unauthenticated. 403 forbidden.
 */
async function addOrganizer(req: Request<IdParams>, res: Response) {
  try {
    const members = await eventModel.addEventMember(
      req.params.id,
      "organizers",
      req.body?.userId,
    );
    res.status(201).json(members);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /events/:id/organizers/:userId
 * Remove a user from the organizers of the event. Removing someone who is not
 * an organizer changes nothing.
 * Who: an owner of the event, or an admin.
 * Returns 200 with the updated list of organizers.
 * Errors: 400 if the event does not exist. 401 unauthenticated. 403 forbidden.
 */
async function removeOrganizer(req: Request<MemberParams>, res: Response) {
  try {
    res.json(
      await eventModel.removeEventMember(
        req.params.id,
        "organizers",
        req.params.userId,
      ),
    );
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
