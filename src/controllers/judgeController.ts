import express, { Request, Response } from "express";
import * as judgeModel from "../models/Judge.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";
import { parsePagination } from "../utils/pagination.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post("/judges", createJudge);
router.get("/judges", getJudges);
router.get("/judges/:id", getJudgeById);
router.patch("/judges/:id", updateJudge);
router.delete("/judges/:id", deleteJudge);

// ============ Handlers ============

/**
 * POST /judges
 * Create a judge in the shared judge directory. A judge is not tied to one
 * event; use POST /events/:id/assignJudge to add a judge to an event.
 * Body: firstName, lastName and email (required). Optional: affiliation,
 * isScience, proficiency, yearsParticipated, phone, notes.
 * The email must be valid and unique.
 * Returns 201 with the judge.
 * Errors: 400 invalid input or email already used.
 */
async function createJudge(req: Request, res: Response) {
  try {
    const {
      firstName,
      lastName,
      email,
      affiliation,
      isScience,
      proficiency,
      yearsParticipated,
      phone,
      notes,
    } = req.body ?? {};
    const judge = await judgeModel.addJudge({
      firstName,
      lastName,
      email,
      affiliation,
      isScience,
      proficiency,
      yearsParticipated,
      phone,
      notes,
    });
    res.status(201).json(judge);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /judges?search=&page=&limit=
 * List the judge directory.
 * search matches first name, last name, email or affiliation (partial, not
 * case-sensitive).
 * Returns 200 with a plain array. The total number of matches is in the
 * X-Total-Count response header.
 */
async function getJudges(req: Request, res: Response) {
  try {
    const { search, page, limit } = req.query;
    const { judges, total } = await judgeModel.getAllJudges(
      typeof search === "string" ? search : undefined,
      parsePagination(page, limit),
    );
    res.set("X-Total-Count", String(total));
    res.json(judges);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /judges/:id
 * One judge.
 * Errors: 400 if the judge does not exist.
 */
async function getJudgeById(req: Request<IdParams>, res: Response) {
  try {
    const judge = await judgeModel.getJudgeById(req.params.id);
    res.json(judge);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /judges/:id
 * Change the profile of a judge. Send only the fields to change (the same
 * fields as when creating).
 * Returns 200 with the updated judge.
 * Errors: 400 invalid input, a field that cannot be updated, email already
 * used, or judge not found.
 */
async function updateJudge(req: Request<IdParams>, res: Response) {
  try {
    const judge = await judgeModel.updateJudgeById(
      req.params.id,
      req.body ?? {},
    );
    res.json(judge);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /judges/:id
 * Delete a judge. Returns 200 with { message, judge }.
 * Note: there is no check yet for events, assignments or scores that use the
 * judge; the delete rules are still to be decided.
 * Errors: 400 if the judge does not exist.
 */
async function deleteJudge(req: Request<IdParams>, res: Response) {
  try {
    const judge = await judgeModel.deleteJudgeById(req.params.id);
    res.json({ message: "Judge deleted", judge });
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
