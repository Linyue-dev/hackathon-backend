import express, { Request, Response } from "express";
import * as judgingAssignmentModel from "../models/JudgingAssignment.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";
import * as scoreModel from "../models/Score.js";
import { InvalidInputError } from "../errors/InvalidInputError.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.patch("/assignments/:id", updateJudgingAssignment);
router.delete("/assignments/:id", deleteJudgingAssignment);
router.post("/assignments/start/:judgeId/:teamId", startAssignment);
router.post("/assignments/end/:judgeId/:teamId", endAssignment);
router.get("/assignments/one/:judgeId", getJudgeTeams);
router.get("/assignments/:judgeId", getJudgeSession);
router.get("/events/:id/assignments", getAssignmentMatrix);
router.put("/events/:id/assignments", saveAssignmentMatrix);
router.post("/events/:id/assignments/one/:judgeId/:teamId", assignOne);
router.delete("/events/:id/assignments/one/:judgeId/:teamId", removeOne);
router.post("/events/:id/assignments/auto", suggestAssignments);

// ============ Handlers ============

type OneParams = { id: string; judgeId: string; teamId: string };

/**
 * POST /events/:id/assignments/one/:judgeId/:teamId
 * Assign one judge to one team. :id is the event id.
 * Body (optional): { slot } a date and time.
 * The judge must be in the event, the team must belong to the event and have
 * status "active", and the team must not be one of the judge's conflicts.
 * If the judge is already assigned to the team, only the slot changes.
 * If the judge already has another team in the same slot, that assignment is replaced.
 * Returns 201 with the assignment when it was created, 200 when it already existed.
 * A new assignment starts with status "pending".
 * Errors:
 *   400 invalid_input - the judge is not in the event, or the team is not in the
 *                       event or is not active
 *   409 conflict_of_interest - the team is in the judge's conflict list
 *   409 already_submitted - the assignment to replace has submitted scores
 */
async function assignOne(req: Request<OneParams>, res: Response) {
  try {
    const { id, judgeId, teamId } = req.params;
    const { assignment, created } = await judgingAssignmentModel.assignOne(
      id,
      judgeId,
      teamId,
      req.body?.slot,
    );
    res.status(created ? 201 : 200).json(assignment);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /events/:id/assignments/one/:judgeId/:teamId
 * Remove one judge from one team. :id is the event id.
 * Returns 200 with { message, assignment }.
 * Errors:
 *   400 invalid_input - the judge is not assigned to the team
 *   409 already_submitted - the judge already submitted scores for the team
 */
async function removeOne(req: Request<OneParams>, res: Response) {
  try {
    const { id, judgeId, teamId } = req.params;
    const assignment = await judgingAssignmentModel.removeOne(
      id,
      judgeId,
      teamId,
    );
    res.json({ message: "Judging assignment removed", assignment });
  } catch (err) {
    handleError(err, res);
  }
}

type StartParams = { judgeId: string; teamId: string };

type JudgeParams = { judgeId: string };

// Until login can tell us the event, it is sent as ?eventId=
function requireEventId(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new InvalidInputError(
      "Invalid input: the eventId query parameter is required",
    );
  return value;
}

/**
 * GET /assignments/one/:judgeId?eventId=
 * "My teams": the teams of one judge in one event, in time slot order.
 * Each item: { teamId, teamName, tableNumber, room, status, slotAt,
 * judgingStartTime, interimSubmittedAt, finalSubmittedAt, awards }.
 * awards has one item per award with scores: { awardId, criteriaScores,
 * comments, total, maxTotal, version, updatedAt }. total is the sum of the
 * criterion values and maxTotal the sum of the criteria's max values.
 * A team without scores yet has an empty awards list.
 * Returns 200 with a plain array.
 * Errors: 400 invalid_input - eventId missing, or the event or judge does not exist.
 */
async function getJudgeTeams(req: Request<JudgeParams>, res: Response) {
  try {
    const eventId = requireEventId(req.query.eventId);
    res.json(await scoreModel.getScoresByJudge(eventId, req.params.judgeId));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /assignments/:judgeId?eventId=
 * The judge's dashboard for one event: the judge, the event and the judging progress.
 * Returns 200 with { judge: { id, firstName, lastName, email, affiliation },
 * event: { id, name, theme, status, judgingStartedAt, judgingEndedAt },
 * progress: { teams, started, submitted, final } }.
 * progress counts the judge's teams: assigned, started, submitted and finally submitted.
 * Errors: 400 invalid_input - eventId missing, the event or judge does not
 * exist, or the judge is not in the event.
 */
async function getJudgeSession(req: Request<JudgeParams>, res: Response) {
  try {
    const eventId = requireEventId(req.query.eventId);
    res.json(
      await judgingAssignmentModel.getJudgeSession(eventId, req.params.judgeId),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /assignments/start/:judgeId/:teamId
 * A judge starts judging a team. No body.
 * Records judgingStartTime and sets the status to "in-progress".
 * Calling it again changes nothing (the first start time is kept).
 * Returns 200 with the assignment.
 * Errors:
 *   400 invalid_input - the judge or team does not exist, or the judge is not
 *                       assigned to the team
 *   409 judging_not_started - judging has not started for this event
 *   423 judging_closed - judging has ended for this event
 */
async function startAssignment(req: Request<StartParams>, res: Response) {
  try {
    const assignment = await judgingAssignmentModel.startAssignment(
      req.params.judgeId,
      req.params.teamId,
    );
    res.json(assignment);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /assignments/end/:judgeId/:teamId
 * A judge ends judging a team. No body. Records judgingEndTime.
 * Calling it again changes nothing (the first end time is kept).
 * Returns 200 with the assignment.
 * Errors:
 *   400 invalid_input - the judge or team does not exist, or the judge is not
 *                       assigned to the team
 *   409 judging_not_started - judging has not started for this event
 *   423 judging_closed - judging has ended for this event
 */
async function endAssignment(req: Request<StartParams>, res: Response) {
  try {
    const assignment = await judgingAssignmentModel.endAssignment(
      req.params.judgeId,
      req.params.teamId,
    );
    res.json(assignment);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/assignments
 * The assignment matrix of an event. :id is the event id.
 * Returns 200 with { teams, judges, assignments, conflicts }.
 * teams: { id, name, tableNumber, room, status }, ordered by table number.
 * judges: { id, firstName, lastName, type, awardIds, workload }, ordered by
 * name. workload is the number of teams the judge is assigned to.
 * assignments: one item per judge and team: { id, teamId, judgeId, slotAt, status }.
 * conflicts: { judgeId, teamId, reason }, the teams a judge must not be assigned to.
 * The teams and judges are always in the same order.
 * Errors: 400 invalid_input - the event does not exist.
 */
async function getAssignmentMatrix(req: Request<IdParams>, res: Response) {
  try {
    res.json(await judgingAssignmentModel.getAssignmentMatrix(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PUT /events/:id/assignments
 * Save the whole matrix of an event. :id is the event id.
 * Body: { assignments: [{ teamId, judgeId, slot }] }. slot is optional (a date and time).
 * The list replaces the current assignments: pairs that are not in the list are
 * removed, new pairs are created, and pairs that already exist only get the new
 * slot. An empty list removes every assignment.
 * Everything is checked before anything is saved.
 * Returns 200 with the new matrix, in the same format as GET.
 * Errors:
 *   400 invalid_input - bad body, a judge that is not in the event, a team that is
 *                       not in the event or not active, or a pair that appears twice
 *   409 conflict_of_interest - a team is in the judge's conflict list
 *   409 already_submitted - the list would remove an assignment whose scores were submitted
 */
async function saveAssignmentMatrix(req: Request<IdParams>, res: Response) {
  try {
    res.json(
      await judgingAssignmentModel.saveAssignmentMatrix(
        req.params.id,
        req.body,
      ),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /assignments/:id
 * Change the time slot or the status. Send only the fields to change.
 * Allowed: status ("pending", "in-progress" or "completed"), slotAt.
 * The judge, team and event cannot be changed.
 * Note: submitting the scores of a team sets the status to "completed" by itself.
 * Returns 200 with the updated assignment.
 * Errors: 400 invalid input, a field that cannot be updated, or assignment not found.
 */
async function updateJudgingAssignment(req: Request<IdParams>, res: Response) {
  try {
    const assignment = await judgingAssignmentModel.updateJudgingAssignmentById(
      req.params.id,
      req.body ?? {},
    );
    res.json(assignment);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /assignments/:id
 * Remove an assignment. Returns 200 with { message, assignment }.
 * Note: it is not refused yet when the judge already has scores for the team.
 * Errors: 400 if the assignment does not exist.
 * 409 already_submitted - the judge has already submitted scores for this team.
 */
async function deleteJudgingAssignment(req: Request<IdParams>, res: Response) {
  try {
    const assignment = await judgingAssignmentModel.deleteJudgingAssignmentById(
      req.params.id,
    );
    res.json({ message: "Judging assignment deleted", assignment });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /events/:id/assignments/auto
 * Suggest who judges which team. :id is the event id.
 * Body (optional): { teamsPerJudge } the most teams one judge may get.
 * Each active team gets 2 to 3 judges, never a judge who has a conflict with
 * the team, and the work is spread evenly.
 * The suggestion is saved only when the event has no assignments yet.
 * Returns 200 with { saved, assignments, uncovered }.
 * saved: true when the assignments were created. assignments: [{ teamId, judgeId }].
 * uncovered: the ids of the teams that could not get at least 2 judges.
 * Errors: 400 invalid_input - the event does not exist or teamsPerJudge is not a positive whole number.
 */
async function suggestAssignments(req: Request<IdParams>, res: Response) {
  try {
    res.json(
      await judgingAssignmentModel.suggestAssignments(req.params.id, req.body),
    );
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
