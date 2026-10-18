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

async function getEventById(req: Request<IdParams>, res: Response) {
  try {
    const event = await eventModel.getEventById(req.params.id);
    res.json(event);
  } catch (err) {
    handleError(err, res);
  }
}

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

async function deleteEvent(req: Request<IdParams>, res: Response) {
  try {
    const event = await eventModel.deleteEventById(req.params.id);
    res.json({ message: "Event deleted", event });
  } catch (err) {
    handleError(err, res);
  }
}
async function startJudging(req: Request<IdParams>, res: Response) {
  try {
    res.json(await eventModel.startJudging(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

async function endJudging(req: Request<IdParams>, res: Response) {
  try {
    res.json(await eventModel.endJudging(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}
export default router;
