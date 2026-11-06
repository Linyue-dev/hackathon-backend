import express, { Request, Response } from "express";
import * as resultModel from "./../models/Result.js";
import { handleError } from "./../utils/errorHandler.js";

const router = express.Router();
export const routeRoot = "/api/v1";

type IdParams = { id: string };

// ============ Routes ============
router.get("/events/:id/results/preliminary", getPreliminaryResults);

// ============ Handlers ============

/**
 * GET /events/:id/results/preliminary?awardId=
 * Ranked teams per challenge, computed live from the submitted scores.
 * :id is the event id. awardId (optional) limits the list to one challenge.
 * Drafts never count. A team's total is the average of its judges' totals,
 * and criteriaAverages is the same average for each criterion.
 * Teams with the same total share a rank.
 * Returns 200 with a list of
 * { awardId, awardName, maxTotal, teams: [{ rank, teamId, teamName, tableNumber, total, criteriaAverages: [{ criterionId, average }] }] }.
 * Errors: 400 invalid_input - the event or award does not exist, or the award is in another event.
 */
async function getPreliminaryResults(req: Request<IdParams>, res: Response) {
  try {
    const awardId =
      typeof req.query.awardId === "string" ? req.query.awardId : undefined;
    res.json(await resultModel.getPreliminaryResults(req.params.id, awardId));
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
