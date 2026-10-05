import express, { Request, Response } from "express";
import * as eventModel from "../models/Event.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";

const router = express.Router();
export const routeRoot = "/api/events";

// ============ Routes ============
router.post("/", createEvent);
router.get("/", getEvents);
router.get("/:id", getEventById);
router.put("/:id", updateEvent);
router.delete("/:id", deleteEvent);

// ============ Handlers ============

async function createEvent(req: Request, res: Response) {
  try {
    const {
      name,
      status,
      logoUrl,
      location,
      startDatetime,
      endDatetime,
      judgingFormId,
      theme,
      description,
    } = req.body;
    const event = await eventModel.addEvent(
      name,
      status,
      logoUrl,
      location,
      startDatetime,
      endDatetime,
      judgingFormId,
      theme,
      description,
    );
    res.status(201).json(event);
  } catch (err) {
    handleError(err, res);
  }
}

async function getEvents(req: Request, res: Response) {
  try {
    const events = await eventModel.getAllEvents();
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
    const event = await eventModel.updateEventById(req.params.id, req.body);
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

export default router;
