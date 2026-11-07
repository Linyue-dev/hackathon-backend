import { MongoError, Db, MongoClient, Collection, ObjectId } from "mongodb";
import bcrypt from "bcrypt";
import { randomInt, randomUUID } from "node:crypto";
import { AppError } from "../errors/AppError.js";
import { DatabaseError } from "../errors/DatabaseError.js";
import { InvalidInputError } from "../errors/InvalidInputError.js";

let client: MongoClient;
export let verificationCodesCollection: Collection<VerificationCode>;

const collectionName: string = "verificationcodes";

export const CODE_LIFETIME_SECONDS = 300;
const MAX_ATTEMPTS = 3;
const MAX_RESENDS = 3;
const RESEND_COOLDOWN_SECONDS = 60;

export type CodePurpose = "signup" | "password-reset";

// A 6-digit code sent by email. Only its hash is stored.
export interface VerificationCode {
  _id?: ObjectId;
  // Given to the client; it points to this code
  challengeId: string;
  userId: string;
  purpose: CodePurpose;
  codeHash: string;
  // Wrong or right tries so far; the code is dead after MAX_ATTEMPTS
  attempts: number;
  resendCount: number;
  isUsed: boolean;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Connect to the database and prepare the verificationcodes collection.
 */
export async function initialize(
  url: string,
  dbName: string,
  resetFlag: boolean,
): Promise<void> {
  try {
    client = new MongoClient(url);
    await client.connect();
    console.log(`Connected to MongoDB - ${collectionName} collection ready`);
    const db: Db = client.db(dbName);

    const collectionCursor = db.listCollections({ name: collectionName });
    const collectionArray = await collectionCursor.toArray();

    if (resetFlag && collectionArray.length > 0) {
      await db.collection(collectionName).drop();
    }
    if (resetFlag || collectionArray.length == 0) {
      const collation = { locale: "en", strength: 1 };
      await db.createCollection(collectionName, { collation: collation });
    }
    verificationCodesCollection = db.collection(collectionName);
    // Codes are deleted a day after they expire
    await verificationCodesCollection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 86400 },
    );
  } catch (err: unknown) {
    if (err instanceof MongoError) {
      console.error("MongoDB connection failed:", err);
    } else if (err instanceof Error) {
      console.error("Unexpected error:", err);
    } else {
      console.error("Unknown error:", err);
    }
  }
}

//#region Code functions

/**
 * Make a new code for a user. Earlier unused codes of the same purpose stop
 * working. Returns the plain code (to email) and the challengeId (to give to
 * the client).
 */
export async function createCode(
  userId: string,
  purpose: CodePurpose,
  resendCount = 0,
): Promise<{ code: string; challengeId: string }> {
  const code = randomInt(100000, 1000000).toString();
  const codeHash = await bcrypt.hash(code, 10);
  const challengeId = randomUUID();
  const now = new Date();

  try {
    await getCollection().updateMany(
      { userId, purpose, isUsed: false },
      { $set: { isUsed: true } },
    );
    await getCollection().insertOne({
      challengeId,
      userId,
      purpose,
      codeHash,
      attempts: 0,
      resendCount,
      isUsed: false,
      createdAt: now,
      expiresAt: new Date(now.getTime() + CODE_LIFETIME_SECONDS * 1000),
    });
  } catch (err: unknown) {
    throw new DatabaseError(
      "Database error: unable to save the code" +
        (err instanceof Error ? "; " + err.message : ""),
    );
  }
  return { code, challengeId };
}

/**
 * Check a code. A code allows MAX_ATTEMPTS tries and works once.
 * Returns the id of the user the code belongs to.
 */
export async function verifyCode(
  challengeId: unknown,
  code: unknown,
  purpose: CodePurpose,
): Promise<string> {
  if (typeof challengeId !== "string" || !challengeId)
    throw new InvalidInputError("Invalid input: challengeId is required");
  if (typeof code !== "string" || !code)
    throw new InvalidInputError("Invalid input: code is required");

  try {
    const now = new Date();
    // The try is counted first, so parallel guesses cannot beat the limit
    const doc = await getCollection().findOneAndUpdate(
      {
        challengeId,
        purpose,
        isUsed: false,
        expiresAt: { $gt: now },
        attempts: { $lt: MAX_ATTEMPTS },
      },
      { $inc: { attempts: 1 } },
      { returnDocument: "after" },
    );

    if (!doc) {
      const old = await getCollection().findOne({ challengeId, purpose });
      if (!old || old.isUsed)
        throw new AppError(
          401,
          "invalid_code",
          "The code is not valid or was already used",
        );
      if (old.expiresAt <= now)
        throw new AppError(
          410,
          "code_expired",
          "The code has expired. Ask for a new one",
        );
      throw new AppError(
        429,
        "too_many_attempts",
        "Too many wrong codes. Ask for a new one",
      );
    }

    if (!(await bcrypt.compare(code, doc.codeHash))) {
      const left = MAX_ATTEMPTS - doc.attempts;
      throw new AppError(
        401,
        "invalid_code",
        left > 0
          ? `Wrong code. ${left} attempt(s) left`
          : "Wrong code. Ask for a new one",
      );
    }

    // Marked used only if nobody else used it first
    const used = await getCollection().updateOne(
      { _id: doc._id, isUsed: false },
      { $set: { isUsed: true } },
    );
    if (used.modifiedCount === 0)
      throw new AppError(
        401,
        "invalid_code",
        "The code is not valid or was already used",
      );
    return doc.userId;
  } catch (err: unknown) {
    if (err instanceof AppError || err instanceof InvalidInputError) throw err;
    throw new DatabaseError(
      "Database error: unable to check the code" +
        (err instanceof Error ? "; " + err.message : ""),
    );
  }
}

/**
 * Send a new code for a challenge that has not been used. At most MAX_RESENDS
 * times, and not more often than every RESEND_COOLDOWN_SECONDS.
 */
export async function resendCode(
  challengeId: unknown,
  purpose: CodePurpose,
): Promise<{ code: string; challengeId: string; userId: string }> {
  if (typeof challengeId !== "string" || !challengeId)
    throw new InvalidInputError("Invalid input: challengeId is required");

  let old: VerificationCode | null;
  try {
    old = await getCollection().findOne({
      challengeId,
      purpose,
      isUsed: false,
    });
  } catch (err: unknown) {
    throw new DatabaseError("Database error: unable to find the code");
  }
  if (!old)
    throw new AppError(
      401,
      "invalid_code",
      "This code request was not found or was already used",
    );
  if (old.resendCount >= MAX_RESENDS)
    throw new AppError(
      429,
      "too_many_resends",
      "Too many new codes were asked for. Sign up again",
    );
  if (Date.now() - old.createdAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000)
    throw new AppError(
      429,
      "resend_too_soon",
      `Wait ${RESEND_COOLDOWN_SECONDS} seconds before asking for a new code`,
    );

  const created = await createCode(old.userId, purpose, old.resendCount + 1);
  return { ...created, userId: old.userId };
}

//#endregion

export async function close() {
  try {
    await client.close();
    console.log("MongoDb connection closed");
  } catch (err: unknown) {
    if (err instanceof Error) console.error(err.message);
    else console.error("Unknown error while attempting to close client");
  }
}

export function getCollection(): Collection<VerificationCode> {
  if (!verificationCodesCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return verificationCodesCollection;
}
