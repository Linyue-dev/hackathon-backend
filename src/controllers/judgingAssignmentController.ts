import express, { Request, Response } from "express";
import * as judgingAssignmentModel from "../models/JudgingAssignment.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";

const router = express.Router();
export const routeRoot = "/api/judging-assignments";

// ============ Routes ============
router.post("/", createJudgingAssignment);
router.get("/", getJudgingAssignments);
router.get("/:id", getJudgingAssignmentById);
router.put("/:id", updateJudgingAssignment);
router.delete("/:id", deleteJudgingAssignment);

// ============ Handlers ============

async function createJudgingAssignment(req: Request, res: Response) {
  try {
    const { eventId, judgeId, teamId } = req.body;
    const assignment = await judgingAssignmentModel.addJudgingAssignment({
      eventId,
      judgeId,
      teamId,
    });
    res.status(201).json(assignment);
  } catch (err) {
    handleError(err, res);
  }
}

async function getJudgingAssignments(req: Request, res: Response) {
  try {
    const { eventId, judgeId, teamId } = req.query;
    const assignments = await judgingAssignmentModel.getAllJudgingAssignments({
      eventId: typeof eventId === "string" ? eventId : undefined,
      judgeId: typeof judgeId === "string" ? judgeId : undefined,
      teamId: typeof teamId === "string" ? teamId : undefined,
    });
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
      req.body,
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
