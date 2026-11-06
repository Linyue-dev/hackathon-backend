import express, { Request, Response } from "express";
import * as resultModel from "./../models/Result.js";
import { handleError } from "./../utils/errorHandler.js";
import * as sponsorChoiceModel from "./../models/SponsorChoice.js";
import * as eventModel from "./../models/Event.js";

const router = express.Router();
export const routeRoot = "/api/v1";

type IdParams = { id: string };
type AwardParams = { id: string; awardId: string };

// ============ Routes ============
router.get("/events/:id/results/preliminary", getPreliminaryResults);
router.get("/events/:id/results/final", getFinalResults);
router.put("/events/:id/results/final/:awardId", setFinalPlacements);
router.post("/events/:id/results/publish", publishResults);
router.post("/events/:id/results/unpublish", unpublishResults);
router.get("/events/:id/results/export.csv", exportResults);

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

/**
 * GET /events/:id/results/final
 * The current final placings of every challenge, and the publish state.
 * :id is the event id.
 * Returns 200 with { resultsPublishedAt, awards: [{ awardId, awardName, placements: [{ teamId, teamName, rank, note }] }] }.
 * resultsPublishedAt is null until the results are published.
 * Errors: 400 invalid_input - the event does not exist.
 */
async function getFinalResults(req: Request<IdParams>, res: Response) {
  try {
    res.json(await sponsorChoiceModel.getFinalResults(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PUT /events/:id/results/final/:awardId
 * Set the final placings of one challenge. The admin may use any order, not
 * only the preliminary one. The list replaces the earlier placings of this
 * challenge, so send the whole list; [] clears it.
 * Body: { placements: [{ teamId, rank, note }] }. rank is a positive whole
 * number and teams can share a rank. note is optional. A team can place only
 * once, and must be an active team of this event.
 * Returns 200 with { awardId, awardName, placements: [{ teamId, teamName, rank, note }] }.
 * Errors: 400 invalid_input - the event, award or a team does not exist, the
 *   award or a team is in another event, a team is not active or repeats, or
 *   a rank is not a positive whole number.
 * 409 results_published - the results are already published.
 */
async function setFinalPlacements(req: Request<AwardParams>, res: Response) {
  try {
    res.json(
      await sponsorChoiceModel.setFinalPlacements(
        req.params.id,
        req.params.awardId,
        req.body ?? {},
      ),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /events/:id/results/publish
 * Publish the winners. resultsPublishedAt is set and the final placings are
 * locked: PUT /events/:id/results/final/:awardId is refused until unpublish.
 * No body. :id is the event id.
 * Returns 200 with the event.
 * Errors: 400 invalid_input - the event does not exist.
 * 409 results_published - the results are already published.
 */
async function publishResults(req: Request<IdParams>, res: Response) {
  try {
    res.json(await eventModel.publishResults(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /events/:id/results/unpublish
 * Undo a publish. resultsPublishedAt is removed and the placings can change again.
 * No body. :id is the event id.
 * Returns 200 with the event.
 * Errors: 400 invalid_input - the event does not exist.
 * 409 results_not_published - the results are not published.
 */
async function unpublishResults(req: Request<IdParams>, res: Response) {
  try {
    res.json(await eventModel.unpublishResults(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/results/export.csv
 * Download the scores and the final placings as a CSV file. :id is the event id.
 * One row per team and challenge. Columns: Challenge, Team, Table,
 * Final rank, Note, Average total, Max total.
 * Returns 200 with the CSV file (text/csv).
 * Errors: 400 invalid_input - the event does not exist.
 */
async function exportResults(req: Request<IdParams>, res: Response) {
  try {
    const csv = await resultModel.exportResultsCsv(req.params.id);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="results.csv"');
    res.send(csv);
  } catch (err) {
    handleError(err, res);
  }
}
export default router;
