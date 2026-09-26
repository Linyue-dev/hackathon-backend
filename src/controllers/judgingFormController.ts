import express, { Request, Response } from "express";
import * as judgingFormModel from "../models/JudgingForm.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";

const router = express.Router();
export const routeRoot = "/api/judging-forms";

// ============ Routes ============
router.post("/", createJudgingForm);
router.get("/", getJudgingForms);
router.get("/:id", getJudgingFormById);
router.put("/:id", updateJudgingForm);
router.delete("/:id", deleteJudgingForm);

// ============ Handlers ============

async function createJudgingForm(req: Request, res: Response) {
  try {
    const { name, criteria, instructions } = req.body;
    const form = await judgingFormModel.addJudgingForm(
      name,
      criteria,
      instructions,
    );
    res.status(201).json(form);
  } catch (err) {
    handleError(err, res);
  }
}

async function getJudgingForms(req: Request, res: Response) {
  try {
    const forms = await judgingFormModel.getAllJudgingForms();
    res.json(forms);
  } catch (err) {
    handleError(err, res);
  }
}

async function getJudgingFormById(req: Request<IdParams>, res: Response) {
  try {
    const form = await judgingFormModel.getJudgingFormById(req.params.id);
    res.json(form);
  } catch (err) {
    handleError(err, res);
  }
}

async function updateJudgingForm(req: Request<IdParams>, res: Response) {
  try {
    const form = await judgingFormModel.updateJudgingFormById(
      req.params.id,
      req.body,
    );
    res.json(form);
  } catch (err) {
    handleError(err, res);
  }
}

async function deleteJudgingForm(req: Request<IdParams>, res: Response) {
  try {
    const form = await judgingFormModel.deleteJudgingFormById(req.params.id);
    res.json({ message: "JudgingForm deleted", form });
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
