import express, { Request, Response } from "express";
import * as userModel from "../models/User.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";

const router = express.Router();
export const routeRoot = "/api/users";

// ============ Routes ============
router.post("/", createUser);
router.get("/", getUsers);
router.get("/:id", getUserById);
router.patch("/:id", updateUser);
router.post("/:id/approve", approveUser);
router.post("/:id/decline", declineUser);
router.patch("/:id/role", changeUserRole);
router.delete("/:id", deleteUser);

// ============ Handlers ============

async function createUser(req: Request, res: Response) {
  try {
    // Only these fields are read. A "role" in the body is ignored.
    const { firstName, lastName, email, password, phone } = req.body;
    const user = await userModel.addUser({
      firstName,
      lastName,
      email,
      password,
      phone,
    });
    res.status(201).json(user);
  } catch (err) {
    handleError(err, res);
  }
}

async function getUsers(req: Request, res: Response) {
  try {
    const { status } = req.query;
    const users = await userModel.getAllUsers({
      status: typeof status === "string" ? status : undefined,
    });
    res.json(users);
  } catch (err) {
    handleError(err, res);
  }
}

async function getUserById(req: Request<IdParams>, res: Response) {
  try {
    res.json(await userModel.getUserById(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

async function updateUser(req: Request<IdParams>, res: Response) {
  try {
    res.json(await userModel.updateUserById(req.params.id, req.body));
  } catch (err) {
    handleError(err, res);
  }
}

async function approveUser(req: Request<IdParams>, res: Response) {
  try {
    res.json(await userModel.approveUser(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

async function declineUser(req: Request<IdParams>, res: Response) {
  try {
    res.json(await userModel.declineUser(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

async function changeUserRole(req: Request<IdParams>, res: Response) {
  try {
    res.json(await userModel.changeUserRole(req.params.id, req.body?.role));
  } catch (err) {
    handleError(err, res);
  }
}

async function deleteUser(req: Request<IdParams>, res: Response) {
  try {
    const user = await userModel.deleteUserById(req.params.id);
    res.json({ message: "User deleted", user });
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
