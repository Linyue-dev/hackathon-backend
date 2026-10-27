import express, { Request, Response } from "express";
import * as teamModel from "../models/Team.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";
import { parsePagination } from "../utils/pagination.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post("/events/:id/teams", createTeam);
router.get("/events/:id/teams", getTeams);
router.get("/teams/:id", getTeamById);
router.patch("/teams/:id", updateTeam);
router.delete("/teams/:id", deleteTeam);

// ============ Handlers ============

/**
 * POST /events/:id/teams
 * Add a team to an event. :id is the event id.
 * Body: name (required). Optional:
 *  - tableNumber: positive integer, unique inside the event
 *  - room, projectUrl, projectDescription: strings
 *  - members: list of { firstName, lastName, email, program, year, school? }
 *  - schools: list of strings
 *  - status: "active" (default), "disqualified" or "withdrawn"
 *  - source: "manual" (default) or "devpost"; devpostId: string
 * Returns 201 with the team.
 * Errors: 400 invalid input, event not found or table number already used.
 */
async function createTeam(req: Request<IdParams>, res: Response) {
  try {
    // The event id comes from the path, not from the body
    const team = await teamModel.addTeam({
      ...req.body,
      eventId: req.params.id,
    });
    res.status(201).json(team);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/teams?status=&search=&page=&limit=
 * List the teams of an event, newest first. :id is the event id.
 * status: "active", "disqualified" or "withdrawn".
 * search matches the team name (partial, not case-sensitive).
 * Returns 200 with a plain array. The total number of matches is in the
 * X-Total-Count response header.
 * Note: the filters awardId and verification are not available yet.
 * Errors: 400 invalid status.
 */
async function getTeams(req: Request<IdParams>, res: Response) {
  try {
    const { status, search, page, limit } = req.query;
    const { teams, total } = await teamModel.getAllTeams(
      req.params.id,
      {
        status: typeof status === "string" ? status : undefined,
        search: typeof search === "string" ? search : undefined,
      },
      parsePagination(page, limit),
    );
    // Total number of matches goes in a header; the body stays a plain array
    res.set("X-Total-Count", String(total));
    res.json(teams);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /teams/:id
 * One team.
 * Errors: 400 if the team does not exist.
 */
async function getTeamById(req: Request<IdParams>, res: Response) {
  try {
    const team = await teamModel.getTeamById(req.params.id);
    res.json(team);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /teams/:id
 * Change some fields of a team. Send only the fields to change.
 * Allowed: name, tableNumber, room, members, schools, projectUrl,
 * projectDescription, status. members and schools are replaced as a whole.
 * Not allowed: eventId, source, devpostId, importedAt.
 * Returns 200 with the updated team.
 * Errors: 400 invalid input, a field that cannot be updated, table number
 * already used, or team not found.
 */
async function updateTeam(req: Request<IdParams>, res: Response) {
  try {
    const team = await teamModel.updateTeamById(req.params.id, req.body ?? {});
    res.json(team);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /teams/:id
 * Delete a team. Returns 200 with { message, team }.
 * Note: there is no check yet for assignments or scores of the team; the
 * delete rules are still to be decided.
 * Errors: 400 if the team does not exist.
 */
async function deleteTeam(req: Request<IdParams>, res: Response) {
  try {
    const team = await teamModel.deleteTeamById(req.params.id);
    res.json({ message: "Team deleted", team });
  } catch (err) {
    handleError(err, res);
  }
}

export default router;