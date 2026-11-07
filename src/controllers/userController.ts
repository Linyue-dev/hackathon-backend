import express, { Request, Response } from "express";
import * as userModel from "../models/User.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";
import { parsePagination } from "../utils/pagination.js";
import { authenticate, requireAdmin } from "../middleware/authenticate.js";
import { AppError } from "../errors/AppError.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post("/users/add", authenticate, requireAdmin, createUser);
router.get("/users", authenticate, requireAdmin, getUsers);
router.get("/users/:id", authenticate, requireAdmin, getUserById);
router.patch("/users/:id", authenticate, requireAdmin, updateUser);
router.post("/users/:id/approve", authenticate, requireAdmin, approveUser);
router.post("/users/:id/decline", authenticate, requireAdmin, declineUser);
router.patch("/users/:id/role", authenticate, requireAdmin, changeUserRole);
router.delete("/users/:id", authenticate, requireAdmin, deleteUser);

// ============ Handlers ============
// Every endpoint here is for admins only (authenticate + requireAdmin).

/**
 * POST /users/add
 * Create an account for a member of the organizing team.
 * Body: firstName, lastName, email, password (required), phone (optional).
 * A "role" in the body is ignored. The email must be valid and unique.
 * Returns 201 with the user.
 * Errors: 400 invalid input or email already used.
 */
async function createUser(req: Request, res: Response) {
  try {
    // Only these fields are read. A "role" in the body is ignored.
    const { firstName, lastName, email, password, phone } = req.body ?? {};
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

/**
 * GET /users?status=&search=&page=&limit=
 * List the users.
 * status: "pending", "active" or "declined".
 * search matches the name or email (partial, not case-sensitive).
 * Returns 200 with a plain array. The total number of matches is in the
 * X-Total-Count response header.
 * Errors: 400 invalid status.
 */
async function getUsers(req: Request, res: Response) {
  try {
    const { status, search, page, limit } = req.query;
    const { users, total } = await userModel.getAllUsers(
      {
        status: typeof status === "string" ? status : undefined,
        search: typeof search === "string" ? search : undefined,
      },
      parsePagination(page, limit),
    );
    res.set("X-Total-Count", String(total));
    res.json(users);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /users/:id
 * One user.
 * Errors: 400 if the user does not exist.
 */
async function getUserById(req: Request<IdParams>, res: Response) {
  try {
    res.json(await userModel.getUserById(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /users/:id
 * Change some fields of a user. Send only the fields to change.
 * The role and the approval status have their own endpoints below.
 * Returns 200 with the updated user.
 * Errors: 400 invalid input, a field that cannot be updated, or user not found.
 */
async function updateUser(req: Request<IdParams>, res: Response) {
  try {
    res.json(await userModel.updateUserById(req.params.id, req.body ?? {}));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /users/:id/approve
 * Approve a pending account. No body. Returns 200 with the user.
 * Errors: 400 if the user does not exist or is not pending.
 */
async function approveUser(req: Request<IdParams>, res: Response) {
  try {
    res.json(await userModel.approveUser(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /users/:id/decline
 * Decline a pending account. No body. Returns 200 with the user.
 * Errors: 400 if the user does not exist or is not pending.
 */
async function declineUser(req: Request<IdParams>, res: Response) {
  try {
    res.json(await userModel.declineUser(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /users/:id/role
 * Promote or demote a user. Body: role (required), "admin" or "viewer".
 * Returns 200 with the user.
 * Errors: 400 invalid role or user not found, or the first admin.
 * 403 cannot_demote_self - an admin cannot change their own role.
 */
async function changeUserRole(req: Request<IdParams>, res: Response) {
  try {
    if (req.params.id === req.auth!.userId && req.body?.role !== "admin")
      throw new AppError(
        403,
        "cannot_demote_self",
        "You cannot change your own role",
      );
    res.json(await userModel.changeUserRole(req.params.id, req.body?.role));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /users/:id
 * Remove a user from the organizing team. Returns 200 with { message, user }.
 * Errors: 400 if the user does not exist.
 */
async function deleteUser(req: Request<IdParams>, res: Response) {
  try {
    const user = await userModel.deleteUserById(req.params.id);
    res.json({ message: "User deleted", user });
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
