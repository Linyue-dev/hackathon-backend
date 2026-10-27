import express, { Request, Response } from "express";
import * as judgingAssignmentModel from "../models/JudgingAssignment.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";
import { parsePagination } from "../utils/pagination.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post("/events/:id/assignments", createJudgingAssignment);
router.get("/events/:id/assignments", getJudgingAssignments);
router.get("/assignments/:id", getJudgingAssignmentById);
router.patch("/assignments/:id", updateJudgingAssignment);
router.delete("/assignments/:id", deleteJudgingAssignment);

// ============ Handlers ============

/**
 * POST /events/:id/assignments
 * Assign one judge to one team. :id is the event id.
 * Body: judgeId and teamId (required), slotAt (optional, a date and time).
 * The judge must be in the event, the team must belong to the event and have
 * status "active", and the team must not be one of the judge's conflicts.
 * A judge can be assigned to the same team only once.
 * Returns 201 with the assignment. Its status starts as "pending".
 * Errors:
 *   400 invalid_input - the judge is not in the event, the team is not in the event
 *                       or is not active, or the judge is already assigned to the team
 *   409 conflict_of_interest - the team is in the judge's conflict list
 */
async function createJudgingAssignment(req: Request<IdParams>, res: Response) {
  try {
    // The event id comes from the path, not from the body
    const { judgeId, teamId, slotAt } = req.body ?? {};
    const assignment = await judgingAssignmentModel.addJudgingAssignment({
      eventId: req.params.id,
      judgeId,
      teamId,
      slotAt,
    });
    res.status(201).json(assignment);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/assignments?judgeId=&teamId=&status=&page=&limit=
 * List the assignments of an event, newest first. :id is the event id.
 * judgeId: only this judge ("my teams"). teamId: only this team.
 * status: "pending", "in-progress" or "completed".
 * Each item: { judgeId, teamId, eventId, status, slotAt, interimSubmittedAt,
 * finalSubmittedAt, createdAt, updatedAt }. The two submitted times are empty
 * until the judge submits.
 * Returns 200 with a plain array. The total number of matches is in the
 * X-Total-Count response header.
 * Errors: 400 invalid status.
 */
async function getJudgingAssignments(req: Request<IdParams>, res: Response) {
  try {
    const { judgeId, teamId, status, page, limit } = req.query;
    const { assignments, total } =
      await judgingAssignmentModel.getAllJudgingAssignments(
        {
          eventId: req.params.id,
          judgeId: typeof judgeId === "string" ? judgeId : undefined,
          teamId: typeof teamId === "string" ? teamId : undefined,
          status: typeof status === "string" ? status : undefined,
        },
        parsePagination(page, limit),
      );
    res.set("X-Total-Count", String(total));
    res.json(assignments);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /assignments/:id
 * One assignment.
 * Errors: 400 if the assignment does not exist.
 */
async function getJudgingAssignmentById(req: Request<IdParams>, res: Response) {
  try {
    const assignment = await judgingAssignmentModel.getJudgingAssignmentById(
      req.params.id,
    );
    res.json(assignment);
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

export default router;
