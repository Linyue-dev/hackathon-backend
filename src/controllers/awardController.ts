import express, { Request, Response } from "express";
import * as awardModel from "../models/Award.js";
import { handleError } from "../utils/errorHandler.js";
import { parsePagination } from "../utils/pagination.js";
import type { IdParams } from "../utils/types.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post("/events/:id/awards", createAward);
router.get("/events/:id/awards", getAwards);
router.get("/awards/:id", getAwardById);
router.patch("/awards/:id", updateAward);
router.delete("/awards/:id", deleteAward);

// ============ Handlers ============

async function createAward(req: Request<IdParams>, res: Response) {
  try {
    // The event id comes from the path, not from the body
    const {
      name,
      type,
      judgedBy,
      sponsoredBy,
      eligibilityCriteria,
      requiresVerification,
    } = req.body;
    const award = await awardModel.addAward({
      eventId: req.params.id,
      name,
      type,
      judgedBy,
      sponsoredBy,
      eligibilityCriteria,
      requiresVerification,
    });
    res.status(201).json(award);
  } catch (err) {
    handleError(err, res);
  }
}

async function getAwards(req: Request<IdParams>, res: Response) {
  try {
    const { search, page, limit } = req.query;
    const { awards, total } = await awardModel.getAllAwards(
      req.params.id,
      typeof search === "string" ? search : undefined,
      parsePagination(page, limit),
    );
    res.set("X-Total-Count", String(total));
    res.json(awards);
  } catch (err) {
    handleError(err, res);
  }
}

async function getAwardById(req: Request<IdParams>, res: Response) {
  try {
    res.json(await awardModel.getAwardById(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

async function updateAward(req: Request<IdParams>, res: Response) {
  try {
    const award = await awardModel.updateAwardById(req.params.id, req.body);
    res.json(award);
  } catch (err) {
    handleError(err, res);
  }
}

async function deleteAward(req: Request<IdParams>, res: Response) {
  try {
    const award = await awardModel.deleteAwardById(req.params.id);
    res.json({ message: "Award deleted", award });
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
