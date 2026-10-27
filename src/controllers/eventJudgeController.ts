import express, { Request, Response } from "express";
import { IdParams } from "../utils/types.js";
import * as eventJudgeModel from "./../models/EventJudge.js";
import { handleError } from "../utils/errorHandler.js";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { parsePagination } from "../utils/pagination.js";
import * as judgingAssignmentModel from "./../models/JudgingAssignment.js";
const router = express.Router();
export const routeRoot = "/api/v1";
type EventJudgeParams = IdParams & { judgeId: string };

// ============ Routes ============
// The id in the path is the event id
router.post("/events/:id/assignJudge", assignJudges);
router.get("/events/:id/judges", getEventJudges);
router.get("/events/:id/judges/:judgeId", getEventJudge);

router.patch("/events/:id/judges/:judgeId", updateEventJudge);
router.put("/events/:id/judges/:judgeId/conflicts", setConflicts);
router.delete("/events/:id/removeJudge/:judgeId", removeJudge);

// ============ Handlers ============

/**
 * POST /events/:id/assignJudge
 * Add existing judges to an event. :id is the event id.
 * Body: judgeIds (required): list of judge ids.
 *       type (optional, default "technical"): "technical", "beginner" or "design".
 * Judges that are already in the event are skipped, not an error.
 * Returns 201 if at least one judge was added, otherwise 200, with
 * { added: [...], alreadyAdded: [...] }.
 * Note: conflict warnings are not returned yet.
 * Errors: 400 invalid input, event not found or a judge not found.
 */
async function assignJudges(req: Request<IdParams>, res: Response) {
  try {
    const { judgeIds, type } = req.body ?? {};
    const result = await eventJudgeModel.addJudgesToEvent(
      req.params.id,
      judgeIds,
      type,
    );
    res.status(result.added.length > 0 ? 201 : 200).json(result);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/judges?type=&hasConflicts=&page=&limit=
 * The judges of an event. :id is the event id.
 * type: "technical", "beginner" or "design".
 * hasConflicts: "true" or "false".
 * Each item: { eventId, judgeId, type, awardIds, conflicts, notes, createdAt }.
 * Returns 200 with a plain array. The total number of matches is in the
 * X-Total-Count response header.
 * Errors: 400 invalid filter value.
 */
async function getEventJudges(req: Request<IdParams>, res: Response) {
  try {
    const { type, hasConflicts, page, limit } = req.query;

    let conflictsFilter: boolean | undefined;
    if (hasConflicts === "true") conflictsFilter = true;
    else if (hasConflicts === "false") conflictsFilter = false;
    else if (hasConflicts !== undefined)
      throw new InvalidInputError(
        "Invalid input: hasConflicts must be true or false",
      );

    const { eventJudges, total } = await eventJudgeModel.getAllEventJudges(
      req.params.id,
      {
        type: typeof type === "string" ? type : undefined,
        hasConflicts: conflictsFilter,
      },
      parsePagination(page, limit),
    );
    res.set("X-Total-Count", String(total));
    res.json(eventJudges);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/judges/:judgeId
 * One judge of an event. :id is the event id.
 * Errors: 400 if the judge is not in the event.
 */
async function getEventJudge(req: Request<EventJudgeParams>, res: Response) {
  try {
    const result = await eventJudgeModel.getEventJudge(
      req.params.id,
      req.params.judgeId,
    );
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /events/:id/judges/:judgeId
 * Change a judge's settings in this event. Send only the fields to change.
 * Allowed: type ("technical", "beginner" or "design"), awardIds (list of award
 * ids; each must exist and belong to this event), notes.
 * Returns 200 with the updated event judge.
 * Errors: 400 invalid input, a field that cannot be updated, or the judge is
 * not in the event.
 */
async function updateEventJudge(req: Request<EventJudgeParams>, res: Response) {
  try {
    res.json(
      await eventJudgeModel.updateEventJudge(
        req.params.id,
        req.params.judgeId,
        req.body ?? {},
      ),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PUT /events/:id/judges/:judgeId/conflicts
 * Set the teams this judge has a conflict of interest with. The list is
 * replaced as a whole; send an empty list to clear it.
 * Body: teamIds (required): list of team ids; each team must exist and belong
 * to this event. reason (optional): string, stored on every conflict.
 * Returns 200 with the updated event judge.
 * Note: assignments that already exist are not checked or removed.
 * Errors: 400 invalid input or the judge is not in the event.
 */
async function setConflicts(req: Request<EventJudgeParams>, res: Response) {
  try {
    const { teamIds, reason } = req.body ?? {};
    res.json(
      await eventJudgeModel.setConflicts(
        req.params.id,
        req.params.judgeId,
        teamIds,
        reason,
      ),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /events/:id/removeJudge/:judgeId
 * Remove a judge from an event. All of the judge's assignments in this event
 * are deleted too.
 * Returns 200 with { message, eventJudge, releasedAssignments } where
 * releasedAssignments is the number of assignments that were deleted.
 * Errors: 400 if the judge is not in the event.
 */
async function removeJudge(req: Request<EventJudgeParams>, res: Response) {
  try {
    const { id, judgeId } = req.params;
    // Throws InvalidInputError if the judge is not in the event
    const eventJudge = await eventJudgeModel.getEventJudge(id, judgeId);
    // The judge's assignments in this event are released first
    const released = await judgingAssignmentModel.releaseJudgeAssignments(
      id,
      judgeId,
    );
    await eventJudgeModel.removeJudgeFromEvent(id, judgeId);
    res.json({
      message: "Judge removed from the event",
      eventJudge,
      releasedAssignments: released,
    });
  } catch (err) {
    handleError(err, res);
  }
}
export default router;
