import express, { Request, Response } from "express";
import * as scoreModel from "./../models/Score.js";
import { handleError } from "./../utils/errorHandler.js";

const router = express.Router();
export const routeRoot = "/api/v1";

type ScoreParams = { teamId: string; judgeId: string };
type ByJudgeParams = { eventId: string; judgeId: string };
type TeamParams = { teamId: string };

// ============ Routes ============
router.put("/scores/:teamId/:judgeId", saveDraftScores);
router.get("/scores/:teamId/raw/:judgeId", getRawScores);
router.post("/scores/:teamId/submit/:judgeId", submitScores);
router.patch("/scores/:teamId/:judgeId", updateScores);
router.post("/scores/:teamId/final/:judgeId", finalSubmitScores);
router.get("/scores/:eventId/byJudge/:judgeId", getScoresByJudge);
router.get("/scores/:teamId/all", getScoresByTeam);
router.get("/scores/:teamId/history/:judgeId", getScoreHistory);

// ============ Handlers ============
// A judge's scores for a team go through three stages:
//  1. draft: PUT saves it as often as needed
//  2. submitted: POST .../submit, then PATCH to change it (old versions are kept)
//  3. final: POST .../final, then it is locked
// Writes are allowed only while the event's judging is started.

/**
 * PUT /scores/:teamId/:judgeId
 * Autosave the draft scores of one judge for one team.
 * Body: a list of { awardId, criteriaScores: [{criterionId, value}], comments: [{category, comment}] }.
 * Each award in the list is replaced; other awards are untouched. Partial criteria
 * and decimal values are allowed (value from 0 to the criterion's max). Safe to repeat.
 * Only awards of this event that are judged by "judge" can be scored.
 * Returns 200 with the judge's saved scores for the team (same shape as the raw GET).
 * Errors: 400 invalid input or judge not assigned to the team,
 * 409 judging_not_started, already_submitted (use PATCH) or final_submitted,
 * 423 judging_closed.
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
 * Drafts and submitted scores are both returned.
 * Returns an empty list if nothing has been scored yet.
 * Errors: 400 if the team or the judge does not exist.
 */
async function getRawScores(req: Request<ScoreParams>, res: Response) {
  try {
    const { teamId, judgeId } = req.params;
    res.json(await scoreModel.getRawScores(teamId, judgeId));
  } catch (err) {
    handleError(err, res);
  }
}
/**
 * POST /scores/:teamId/submit/:judgeId
 * Submit the judge's scores for a team (first time). Same body as the PUT.
 * Every award with scores must have all its criteria scored.
 * Records the submit time on the assignment (interimSubmittedAt) and sets its
 * status to "completed". Returns 200 with the saved scores.
 * Errors: 400 invalid input, 409 already_submitted, judging_not_started or
 * final_submitted, 422 incomplete_scores, 423 judging_closed.
 */
async function submitScores(req: Request<ScoreParams>, res: Response) {
  try {
    const { teamId, judgeId } = req.params;
    res.json(await scoreModel.submitScores(teamId, judgeId, req.body));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /scores/:teamId/:judgeId
 * Change scores after the first submit. Same body as the PUT.
 * Each award in the list is replaced and must be complete. If its content
 * changed, it gets a new version and the old one is kept in history. If it did
 * not change, nothing happens.
 * Returns 200 with the current scores.
 * Errors: 400 invalid input, 409 not_submitted or final_submitted,
 * 422 incomplete_scores, 423 judging_closed.
 */
async function updateScores(req: Request<ScoreParams>, res: Response) {
  try {
    const { teamId, judgeId } = req.params;
    res.json(await scoreModel.updateScores(teamId, judgeId, req.body));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /scores/:teamId/final/:judgeId
 * Final submit for a team. The scores must have been submitted before.
 * Same body as the PATCH; changed awards get a new version. Records the
 * final submit time on the assignment (finalSubmittedAt), and the scores are
 * locked after it: PUT, submit, PATCH and a second final all return 409.
 * Returns 200 with the final scores.
 * Errors: 400 invalid input, 409 not_submitted or final_submitted,
 * 422 incomplete_scores, 423 judging_closed.
 */
async function finalSubmitScores(req: Request<ScoreParams>, res: Response) {
  try {
    const { teamId, judgeId } = req.params;
    res.json(await scoreModel.finalSubmitScores(teamId, judgeId, req.body));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /scores/:eventId/byJudge/:judgeId
 * "My scores" of one judge in one event: one item per assigned team with
 * { teamId, teamName, tableNumber, status, slotAt, interimSubmittedAt,
 * finalSubmittedAt, awards: [{ awardId, criteriaScores, comments, version, updatedAt }] }.
 * Teams without scores have an empty awards list.
 * Errors: 400 if the event or the judge does not exist.
 */
async function getScoresByJudge(req: Request<ByJudgeParams>, res: Response) {
  try {
    const { eventId, judgeId } = req.params;
    res.json(await scoreModel.getScoresByJudge(eventId, judgeId));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /scores/:teamId/all
 * The scores of one team from every judge who scored it: one item per judge with
 * { judgeId, judgeName, interimSubmittedAt, finalSubmittedAt, awards: [...] }.
 * interimSubmittedAt is empty while the judge is still saving drafts.
 * Returns an empty list if nobody scored the team.
 * Errors: 400 if the team does not exist.
 */
async function getScoresByTeam(req: Request<TeamParams>, res: Response) {
  try {
    res.json(await scoreModel.getScoresByTeam(req.params.teamId));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /scores/:teamId/history/:judgeId
 * Audit info: every version of the judge's scores for the team, per award:
 * { awardId, versions: [{ version, criteriaScores, comments, savedAt }] }.
 * Old versions come first; the last one is the current version. A draft has
 * only one version. Returns an empty list if there are no scores.
 * Errors: 400 if the team or the judge does not exist.
 */
async function getScoreHistory(req: Request<ScoreParams>, res: Response) {
  try {
    const { teamId, judgeId } = req.params;
    res.json(await scoreModel.getScoreHistory(teamId, judgeId));
  } catch (err) {
    handleError(err, res);
  }
}
export default router;