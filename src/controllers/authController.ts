import express, { Request, Response } from "express";
import * as userModel from "../models/User.js";
import * as verificationCodeModel from "../models/VerificationCode.js";
import { sendMail } from "../utils/mailService.js";
import { signToken } from "../utils/token.js";
import { handleError } from "../utils/errorHandler.js";
import { AppError } from "../errors/AppError.js";
import { authenticate } from "../middleware/authenticate.js";
import * as eventModel from "../models/Event.js";
import * as judgeModel from "../models/Judge.js";
import * as eventJudgeModel from "../models/EventJudge.js";
import { randomUUID } from "node:crypto";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post("/auth/signup", signup);
router.post("/auth/verify", verify);
router.post("/auth/resend", resend);
router.post("/auth/password/forgot", forgotPassword);
router.post("/auth/password/reset", resetPassword);

router.post("/auth/login", login);
router.get("/auth/me", authenticate, me);
router.post("/auth/logout", authenticate, logout);

// ============ Handlers ============

/**
 * POST /auth/signup
 * Create an account and email a 6-digit code to the given address.
 * Body: firstName, lastName, email, password (required), phone (optional).
 * The account starts as a pending viewer and becomes active when the code is
 * accepted by POST /auth/verify. Signing up again with the email of a pending
 * account replaces its details and sends a new code.
 * Returns 201 with { challengeId, expiresInSeconds }.
 * Errors: 400 invalid input or the email already belongs to an active account.
 * 502 email_failed - the email could not be sent.
 */
async function signup(req: Request, res: Response) {
  try {
    const { firstName, lastName, email, password, phone } = req.body ?? {};
    const user = await userModel.addUser({
      firstName,
      lastName,
      email,
      password,
      phone,
    });
    const { code, challengeId } = await verificationCodeModel.createCode(
      String(user._id),
      "signup",
    );
    await sendCode(user.email, code);
    res.status(201).json({
      challengeId,
      expiresInSeconds: verificationCodeModel.CODE_LIFETIME_SECONDS,
    });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /auth/verify
 * Check the code from the email. If it is right the account becomes active and
 * the user is logged in at once.
 * Body: challengeId (from signup or resend), code (6 digits).
 * A code allows 3 tries, works once and expires after 5 minutes.
 * Returns 200 with { token, user }. Send the token as "Authorization: Bearer <token>".
 * Errors: 400 invalid input.
 * 401 invalid_code - wrong code (the message says how many tries are left) or
 *   unknown / used code. 410 code_expired. 429 too_many_attempts.
 * 403 account_declined - an admin declined this account.
 */
async function verify(req: Request, res: Response) {
  try {
    const { challengeId, code } = req.body ?? {};
    const userId = await verificationCodeModel.verifyCode(
      challengeId,
      code,
      "signup",
    );
    const user = await userModel.activateUser(userId);
    res.json({ token: signToken(String(user._id)), user });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /auth/resend
 * Email a new code for a sign up that is not verified yet. The old code stops
 * working.
 * Body: challengeId.
 * At most 3 times, and not more often than every 60 seconds.
 * Returns 200 with { challengeId, expiresInSeconds }. Use the new challengeId.
 * Errors: 400 invalid input. 401 invalid_code - unknown or already used.
 * 429 resend_too_soon or too_many_resends. 502 email_failed.
 */
async function resend(req: Request, res: Response) {
  try {
    const { challengeId } = req.body ?? {};
    const created = await verificationCodeModel.resendCode(
      challengeId,
      "signup",
    );
    const user = await userModel.getUserById(created.userId);
    await sendCode(user.email, created.code);
    res.json({
      challengeId: created.challengeId,
      expiresInSeconds: verificationCodeModel.CODE_LIFETIME_SECONDS,
    });
  } catch (err) {
    handleError(err, res);
  }
}

// ============ Helpers ============

async function sendCode(email: string, code: string) {
  const minutes = verificationCodeModel.CODE_LIFETIME_SECONDS / 60;
  try {
    await sendMail({
      recipientEmail: email,
      subject: "Your JacHacks Judging verification code",
      text: `Your verification code is ${code}. It expires in ${minutes} minutes.\n\nIf you did not sign up, you can ignore this email.`,
      html: `<p>Your verification code is:</p><h1 style="letter-spacing: 5px;">${code}</h1><p>It expires in ${minutes} minutes.</p><p>If you did not sign up, you can ignore this email.</p>`,
    });
  } catch (err) {
    console.error("Unable to send the verification email:", err);
    throw new AppError(
      502,
      "email_failed",
      "The verification email could not be sent. Try again later",
    );
  }
}

/**
 * POST /auth/login
 * Body: email, password. A judge logs in with the code of an event as the password.
 * Returns 200 with { token, user }. Send the token as "Authorization: Bearer <token>".
 * Errors: 400 invalid input. 401 invalid_credentials. 403 email_not_verified,
 * account_declined or code_expired - judging has ended in the event of the code.
 * 429 account_locked - 5 wrong passwords lock it for 15 minutes.
 */
async function login(req: Request, res: Response) {
  try {
    const { email, password } = req.body ?? {};
    const { user, eventId } = await userModel.loginUser(
      email,
      password,
      eventJudgeModel.findEventByCode,
    );
    res.json({ token: signToken(String(user._id), eventId), user });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /auth/me
 * The logged-in user and the events where the user has a role.
 * Returns 200 with { user, judgeId, events }.
 * user: id, name, email, role, isLimited, status.
 * judgeId: the id of the judge this account belongs to, or null.
 * events: [{ eventId, name, roles }], roles holds "owner", "organizer" and/or
 * "judge". Mentor events are not included yet.
 * Errors: 401 unauthenticated or invalid_token.
 */
async function me(req: Request, res: Response) {
  try {
    const userId = req.auth!.userId;
    const user = await userModel.getUserById(userId);
    const events = await eventModel.getEventsOfUser(userId);
    const judge = await judgeModel.getJudgeByUserId(userId);
    if (judge) {
      const judgeEvents = await eventJudgeModel.getEventsOfJudge(
        String(judge._id),
      );
      for (const e of judgeEvents) {
        const found = events.find((x) => x.eventId === e.eventId);
        if (found) found.roles.push("judge");
        else events.push({ ...e, roles: ["judge"] });
      }
    }
    res.json({ user, judgeId: judge ? String(judge._id) : null, events });
  } catch (err) {
    handleError(err, res);
  }
}
/**
 * POST /auth/logout
 * Tokens are not kept on the server: the client forgets the token. Returns 204.
 */
function logout(_req: Request, res: Response) {
  res.status(204).end();
}

/**
 * POST /auth/password/forgot
 * Email a 6-digit code to reset the password.
 * Body: email.
 * Always returns 200 with { challengeId, expiresInSeconds }, also for an email
 * that has no account, so nobody can find out which emails have accounts. The
 * email is sent only to an active account that has a password (a judge who
 * signs in with a code has none).
 * Errors: 400 invalid input. 502 email_failed.
 */
async function forgotPassword(req: Request, res: Response) {
  try {
    const userId = await userModel.findResettableUserId(req.body?.email);
    let challengeId: string = randomUUID();
    if (userId) {
      const created = await verificationCodeModel.createCode(
        userId,
        "password-reset",
      );
      const user = await userModel.getUserById(userId);
      await sendResetCode(user.email, created.code);
      challengeId = created.challengeId;
    }
    res.json({
      challengeId,
      expiresInSeconds: verificationCodeModel.CODE_LIFETIME_SECONDS,
    });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /auth/password/reset
 * Set a new password with the code from the email.
 * Body: challengeId (from forgot), code (6 digits), newPassword.
 * A code allows 3 tries, works once and expires after 5 minutes. The login
 * lock of the account is cleared. The user is not logged in: log in with the
 * new password.
 * Returns 200 with { message }.
 * Errors: 400 invalid input or a password that is too weak.
 * 401 invalid_code - wrong, unknown or used code. 410 code_expired.
 * 429 too_many_attempts.
 */
async function resetPassword(req: Request, res: Response) {
  try {
    const { challengeId, code, newPassword } = req.body ?? {};
    // Checked first, so a weak password does not use up the code
    userModel.assertValidPassword(newPassword);
    const userId = await verificationCodeModel.verifyCode(
      challengeId,
      code,
      "password-reset",
    );
    await userModel.setPassword(userId, newPassword);
    res.json({ message: "Password changed. Log in with the new password" });
  } catch (err) {
    handleError(err, res);
  }
}

// ============ Helpers ============
async function sendResetCode(email: string, code: string) {
  const minutes = verificationCodeModel.CODE_LIFETIME_SECONDS / 60;
  try {
    await sendMail({
      recipientEmail: email,
      subject: "Your JacHacks Judging password reset code",
      text: `Your password reset code is ${code}. It expires in ${minutes} minutes.\n\nIf you did not ask for this, you can ignore this email.`,
      html: `<p>Your password reset code is:</p><h1 style="letter-spacing: 5px;">${code}</h1><p>It expires in ${minutes} minutes.</p><p>If you did not ask for this, you can ignore this email.</p>`,
    });
  } catch (err) {
    console.error("Unable to send the password reset email:", err);
    throw new AppError(
      502,
      "email_failed",
      "The email could not be sent. Try again later",
    );
  }
}
export default router;
