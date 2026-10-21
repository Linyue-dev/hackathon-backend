import express, { Request, Response } from "express";
import * as scoreModel from "./../models/Score.js";
import { handleError } from "./../utils/errorHandler.js";

const router = express.Router();
export const routeRoot = "/api/v1";

type ScoreParams = { teamId: string; judgeId: string };

// ============ Routes ============
router.put("/scores/:teamId/:judgeId", saveDraftScores);
router.get("/scores/:teamId/raw/:judgeId", getRawScores);

// ============ Handlers ============

/**
 * PUT /scores/:teamId/:judgeId
 * Autosave the draft scores of one judge for one team.
 * Body: a list of { awardId, criteriaScores: [{criterionId, value}], comments: [{category, comment}] }.
 * Each award in the list is replaced; other awards are untouched. Partial criteria
 * and decimal values are allowed. Safe to repeat.
 * Returns 200 with the judge's saved scores for the team (same shape as the raw GET).
 * Errors: 400 invalid input or judge not assigned to the team,
 * 409 judging_not_started, 423 judging_closed.
 */
async function saveDraftScores(req: Request<ScoreParams>, res: Response) {
  try {
    const { teamId, judgeId } = req.params;
    res.json(await scoreModel.saveDraftScores(teamId, judgeId, req.body));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /scores/:teamId/raw/:judgeId
 * Raw scores of one judge for one team, one item per award:
 * { awardId, criteriaScores, comments, version, updatedAt }.
 * Returns an empty list if nothing has been scored yet.
 */
async function getRawScores(req: Request<ScoreParams>, res: Response) {
  try {
    const { teamId, judgeId } = req.params;
    res.json(await scoreModel.getRawScores(teamId, judgeId));
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
