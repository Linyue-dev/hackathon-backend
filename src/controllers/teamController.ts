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

async function getTeamById(req: Request<IdParams>, res: Response) {
  try {
    const team = await teamModel.getTeamById(req.params.id);
    res.json(team);
  } catch (err) {
    handleError(err, res);
  }
}

async function updateTeam(req: Request<IdParams>, res: Response) {
  try {
    const team = await teamModel.updateTeamById(req.params.id, req.body ?? {});
    res.json(team);
  } catch (err) {
    handleError(err, res);
  }
}

async function deleteTeam(req: Request<IdParams>, res: Response) {
  try {
    const team = await teamModel.deleteTeamById(req.params.id);
    res.json({ message: "Team deleted", team });
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
