import express, { Request, Response } from "express";
import * as teamModel from "../models/Team.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";

const router = express.Router();
export const routeRoot = "/api/teams";

// ============ Routes ============
router.post("/", createTeam);
router.get("/", getTeams);
router.get("/:id", getTeamById);
router.put("/:id", updateTeam);
router.delete("/:id", deleteTeam);

// ============ Handlers ============

async function createTeam(req: Request, res: Response) {
  try {
    const team = await teamModel.addTeam(req.body);
    res.status(201).json(team);
  } catch (err) {
    handleError(err, res);
  }
}

async function getTeams(req: Request, res: Response) {
  try {
    const eventId =
      typeof req.query.eventId === "string" ? req.query.eventId : undefined;
    const teams = await teamModel.getAllTeams(eventId);
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
    const team = await teamModel.updateTeamById(req.params.id, req.body);
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