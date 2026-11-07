import express, { Request, Response } from "express";
import * as userModel from "../models/User.js";
import * as verificationCodeModel from "../models/VerificationCode.js";
import { sendMail } from "../utils/mailService.js";
import { signToken } from "../utils/token.js";
import { handleError } from "../utils/errorHandler.js";
import { AppError } from "../errors/AppError.js";
import { authenticate } from "../middleware/authenticate.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post("/auth/signup", signup);
router.post("/auth/verify", verify);
router.post("/auth/resend", resend);

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
 * Body: email, password. A judge / mentor code account uses its code as the password.
 * Returns 200 with { token, user }. Send the token as "Authorization: Bearer <token>".
 * Errors: 400 invalid input. 401 invalid_credentials. 403 email_not_verified or
 * account_declined. 429 account_locked - 5 wrong passwords lock it for 15 minutes.
 */
async function login(req: Request, res: Response) {
  try {
    const { email, password } = req.body ?? {};
    const user = await userModel.loginUser(email, password);
    res.json({ token: signToken(String(user._id)), user });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /auth/me
 * The logged-in user: id, name, email, role, isLimited, status.
 * Errors: 401 unauthenticated or invalid_token.
 */
async function me(req: Request, res: Response) {
  try {
    res.json({ user: await userModel.getUserById(req.auth!.userId) });
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

export default router;
