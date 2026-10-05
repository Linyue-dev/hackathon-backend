import express, { Request, Response } from "express";
import * as judgeModel from "../models/Judge.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";

const router = express.Router();
export const routeRoot = "/api/judges";

// ============ Routes ============
router.post("/", createJudge);
router.get("/", getJudges);
router.get("/:id", getJudgeById);
router.put("/:id", updateJudge);
router.delete("/:id", deleteJudge);

// ============ Handlers ============

async function createJudge(req: Request, res: Response) {
  try {
    const {
      firstName,
      lastName,
      email,
      affiliation,
      isTechnical,
      isScience,
      proficiency,
      yearsParticipated,
      phone,
      notes,
    } = req.body;
    const judge = await judgeModel.addJudge(
      firstName,
      lastName,
      email,
      affiliation,
      isTechnical,
      isScience,
      proficiency,
      yearsParticipated,
      phone,
      notes,
    );
    res.status(201).json(judge);
  } catch (err) {
    handleError(err, res);
  }
}

async function getJudges(req: Request, res: Response) {
  try {
    const judges = await judgeModel.getAllJudges();
    res.json(judges);
  } catch (err) {
    handleError(err, res);
  }
}

async function getJudgeById(req: Request<IdParams>, res: Response) {
  try {
    const judge = await judgeModel.getJudgeById(req.params.id);
    res.json(judge);
  } catch (err) {
    handleError(err, res);
  }
}

async function updateJudge(req: Request<IdParams>, res: Response) {
  try {
    const judge = await judgeModel.updateJudgeById(req.params.id, req.body);
    res.json(judge);
  } catch (err) {
    handleError(err, res);
  }
}

async function deleteJudge(req: Request<IdParams>, res: Response) {
  try {
    const judge = await judgeModel.deleteJudgeById(req.params.id);
    res.json({ message: "Judge deleted", judge });
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
