import express, { Request, Response } from "express";
import * as awardModel from "../models/Award.js";
import { handleError } from "../utils/errorHandler.js";
import { parsePagination } from "../utils/pagination.js";
import type { IdParams } from "../utils/types.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post("/events/:id/awards", createAward);
router.get("/events/:id/awards", getAwards);
router.get("/awards/:id", getAwardById);
router.patch("/awards/:id", updateAward);
router.delete("/awards/:id", deleteAward);

router.get("/awards/:id/form", getForm);
router.put("/awards/:id/form", saveForm);

// ============ Handlers ============

/**
 * POST /events/:id/awards
 * Add an award (a "challenge" in the UI) to an event. :id is the event id.
 * Body:
 *  - name (required): unique inside the event, not case-sensitive
 *  - type (required): "top-level" or "mini-challenge"
 *  - judgedBy (optional, default "judge"): "organizer", "sponsor" or "judge"
 *  - sponsoredBy (optional): string
 *  - eligibilityCriteria (optional): string
 *  - requiresVerification (optional, default false): true or false
 *  - judgingCriteria (optional): list of { category, question, weight, max, id? }.
 *    weight and max must be greater than 0. A missing id is generated.
 * Returns 201 with the award, including instructions ("") and criteria (with ids).
 * Errors: 400 invalid input, event not found or name already used.
 */
async function createAward(req: Request<IdParams>, res: Response) {
  try {
    // The event id comes from the path, not from the body
    const {
      name,
      type,
      judgedBy,
      sponsoredBy,
      eligibilityCriteria,
      requiresVerification,
      judgingCriteria,
    } = req.body ?? {};
    const award = await awardModel.addAward({
      eventId: req.params.id,
      name,
      type,
      judgedBy,
      sponsoredBy,
      eligibilityCriteria,
      requiresVerification,
      judgingCriteria,
    });
    res.status(201).json(award);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/awards?search=&page=&limit=
 * List the awards of an event, oldest first. :id is the event id.
 * search matches the name (partial, not case-sensitive).
 * Returns 200 with a plain array. The total number of matches is in the
 * X-Total-Count response header.
 */
async function getAwards(req: Request<IdParams>, res: Response) {
  try {
    const { search, page, limit } = req.query;
    const { awards, total } = await awardModel.getAllAwards(
      req.params.id,
      typeof search === "string" ? search : undefined,
      parsePagination(page, limit),
    );
    res.set("X-Total-Count", String(total));
    res.json(awards);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /awards/:id
 * One award, including instructions and criteria.
 * Errors: 400 if the award does not exist.
 */
async function getAwardById(req: Request<IdParams>, res: Response) {
  try {
    res.json(await awardModel.getAwardById(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /awards/:id
 * Change some fields of an award. Send only the fields to change.
 * Allowed: name, type, judgedBy, sponsoredBy, eligibilityCriteria,
 * requiresVerification (same rules as when creating).
 * Not allowed: eventId, criteria, instructions. Use PUT /awards/:id/form for
 * the last two.
 * Returns 200 with the updated award.
 * Errors: 400 invalid input, a field that cannot be updated, no field sent,
 * name already used in the event, or award not found.
 */
async function updateAward(req: Request<IdParams>, res: Response) {
  try {
    const award = await awardModel.updateAwardById(
      req.params.id,
      req.body ?? {},
    );
    res.json(award);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /awards/:id
 * Delete an award. Returns 200 with { message, award }.
 * Note: there is no check yet for scores that point to the award.
 * Errors: 400 if the award does not exist.
 */
async function deleteAward(req: Request<IdParams>, res: Response) {
  try {
    const award = await awardModel.deleteAwardById(req.params.id);
    res.json({ message: "Award deleted", award });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /awards/:id/form
 * The judging form of an award: { awardId, instructions, criteria }.
 * criteria is a list of { id, category, question, weight, max }. A new award
 * without criteria returns an empty list. The criteria ids are what scores
 * refer to (criterionId).
 * Errors: 400 if the award does not exist.
 */
async function getForm(req: Request<IdParams>, res: Response) {
  try {
    res.json(await awardModel.getFormByAwardId(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PUT /awards/:id/form
 * Replace the whole form of an award: send the full list every time.
 * Body:
 *  - criteria (required): list of { category, question, weight, max, id? }.
 *    Send the old id of an item you keep, so its saved scores stay valid.
 *    Items without an id get a new one. Ids must be unique in the list.
 *  - instructions (optional): string. If missing, it becomes "".
 * Send "criteria": [] to remove all criteria.
 * Returns 200 with { awardId, instructions, criteria }.
 * Errors: 400 invalid input or award not found.
 */
async function saveForm(req: Request<IdParams>, res: Response) {
  try {
    const { criteria, instructions } = req.body ?? {};
    res.json(
      await awardModel.saveFormByAwardId(req.params.id, {
        criteria,
        instructions,
      }),
    );
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
