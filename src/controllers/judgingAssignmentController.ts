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
