import express, { Request, Response } from "express";
import * as eventModel from "../models/Event.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";
import { parsePagination } from "../utils/pagination.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post("/events", createEvent);
router.get("/events", getEvents);
router.get("/events/:id", getEventById);
router.patch("/events/:id", updateEvent);
router.delete("/events/:id", deleteEvent);

router.post("/events/:id/judging/start", startJudging);
router.post("/events/:id/judging/end", endJudging);
// ============ Handlers ============

/**
 * POST /events
 * Create an event.
 * Body: name (required). Optional: status, theme, description,
 * address { street, city, province, postal }, rooms (list of strings),
 * arrivalNotes, logoUrl, location, startDatetime, endDatetime.
 * Status values: draft, in-progress, judging-started, judging-ended, complete.
 * judgingStartedAt, judgingEndedAt and resultsPublishedAt are set by the
 * server and cannot be sent.
 * Returns 201 with the event.
 * Errors: 400 invalid input.
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
      location,
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
      location,
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
 * Returns 200 with a plain array. The total number of matches is in the
 * X-Total-Count response header.
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
    // The body stays a plain array; the total count goes in a header
    res.set("X-Total-Count", String(total));
    res.json(events);
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
 * logoUrl, location, startDatetime, endDatetime.
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
export default router;