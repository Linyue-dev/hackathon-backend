import {
  MongoError,
  Db,
  MongoClient,
  Collection,
  ObjectId,
  WithId,
  Filter,
} from "mongodb";
import bcrypt from "bcrypt";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { DatabaseError } from "../errors/DatabaseError.js";
import {
  isValidEmail,
  normalizeEmail,
  pickFields,
  getPasswordError,
  assertOnlyAllowedFields,
  escapeRegex,
} from "../utils/validateUtils.js";
import { Pagination } from "../utils/pagination.js";
import { AppError } from "../errors/AppError.js";

let client: MongoClient;
export let usersCollection: Collection<User>;

const collectionName: string = "users";

export interface User {
  _id?: ObjectId;
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
  phone?: string;
  role: "admin" | "viewer";
  status: "pending" | "active" | "declined";
  createdAt: Date;
  updatedAt: Date;
  // true only for judge / mentor code accounts; they can do nothing else
  isLimited: boolean;
  failedLoginAttempts?: number;
  lockedUntil?: Date;
}

// What we return to callers: never the password hash or the login lock data.
export type PublicUser = Omit<
  User,
  "passwordHash" | "failedLoginAttempts" | "lockedUntil"
>;

export interface NewUserInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
}

export interface UserFilter {
  status?: string;
  search?: string;
}

const USER_STATUSES = ["pending", "active", "declined"] as const;
const ASSIGNABLE_ROLES = ["admin", "viewer"] as const;
const SALT_ROUNDS = 10;

// Role and status are never changed through the normal update.
const UPDATABLE_FIELDS = ["firstName", "lastName", "phone"] as const;

// The first admin is the account whose email is ADMIN_EMAIL
function isFirstAdmin(email: string): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  return !!adminEmail && email === normalizeEmail(adminEmail);
}

/**
 * Connect to the database and prepare the users collection.
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
    usersCollection = db.collection(collectionName);
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

//#region Add functions

/**
 * Sign up a new account. It starts as a pending viewer; the code sent by email
 * activates it (see activateUser). An account that is still pending can sign up
 * again: the new details replace the old ones, because its email was never
 * verified.
 */
export async function addUser(input: NewUserInput): Promise<PublicUser> {
  if (!usersCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const { firstName, lastName, email, password, phone } = input;

  if (!firstName)
    throw new InvalidInputError("Invalid input: user firstName is empty");
  if (!lastName)
    throw new InvalidInputError("Invalid input: user lastName is empty");
  if (!email) throw new InvalidInputError("Invalid input: user email is empty");
  if (!isValidEmail(email))
    throw new InvalidInputError(
      `Invalid input: '${email}' is not a valid email`,
    );
  const passwordError = getPasswordError(password);
  if (passwordError) throw new InvalidInputError(passwordError);

  const normalizedEmail = normalizeEmail(email);

  try {
    const existing = await usersCollection.findOne({ email: normalizedEmail });
    if (existing && existing.status !== "pending")
      throw new InvalidInputError(
        `An account with the email ${email} already exists`,
      );

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    if (existing)
      return await saveChanges(existing._id, {
        firstName,
        lastName,
        passwordHash,
        phone,
      });

    const now = new Date();
    const user: User = {
      firstName,
      lastName,
      email: normalizedEmail,
      passwordHash,
      phone,
      role: "viewer",
      status: "pending",
      isLimited: false,
      createdAt: now,
      updatedAt: now,
    };

    await usersCollection.insertOne(user);
    return toPublicUser(user);
  } catch (err: unknown) {
    if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new DatabaseError(
        "Database error: unable to insert user; " + err.message,
      );
    else throw new Error("Unknown error: " + err);
  }
}

//#endregion

//#region Get functions

export async function getUserById(id: string): Promise<PublicUser> {
  return toPublicUser(await findUserById(id));
}

/**
 * Get users, with optional status filter (e.g. "pending" approvals),
 * search (name or email) and paging.
 */
export async function getAllUsers(
  filter: UserFilter,
  pagination: Pagination,
): Promise<{ users: PublicUser[]; total: number }> {
  if (!usersCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const { status, search } = filter;
  if (status !== undefined && !isValidStatus(status))
    throw new InvalidInputError(
      `Invalid input: status '${status}' is not valid`,
    );

  const query: Filter<User> = {};
  if (status) query.status = status;
  if (search) {
    const regex = { $regex: escapeRegex(search), $options: "i" };
    query.$or = [{ firstName: regex }, { lastName: regex }, { email: regex }];
  }

  try {
    const [users, total] = await Promise.all([
      usersCollection
        .find(query)
        .sort({ createdAt: -1, _id: 1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .toArray(),
      usersCollection.countDocuments(query),
    ]);
    return { users: users.map(toPublicUser), total };
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve users",
    );
  }
}

//#endregion

//#region Update functions

/**
 * Update profile fields only. Role and status have their own functions below.
 */
export async function updateUserById(
  id: string,
  updates: Partial<Pick<User, "firstName" | "lastName" | "phone">>,
): Promise<PublicUser> {
  const oldUser = await findUserById(id);

  assertOnlyAllowedFields(updates, UPDATABLE_FIELDS);

  const cleanUpdates = pickFields(updates, UPDATABLE_FIELDS);
  if (Object.keys(cleanUpdates).length === 0)
    throw new InvalidInputError(
      "Update user error: at least one valid field must be provided",
    );

  if (cleanUpdates.firstName !== undefined && !cleanUpdates.firstName)
    throw new InvalidInputError("Invalid input: user firstName is empty");
  if (cleanUpdates.lastName !== undefined && !cleanUpdates.lastName)
    throw new InvalidInputError("Invalid input: user lastName is empty");

  try {
    return await saveChanges(oldUser._id, cleanUpdates);
  } catch (err: unknown) {
    if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new DatabaseError(
        `Update User Error: failed to update user ${id}; ${err.message}`,
      );
    else throw new Error("Unknown error " + err);
  }
}

/**
 * Approve a pending account.
 */
export async function approveUser(id: string): Promise<PublicUser> {
  const user = await findUserById(id);
  if (user.status !== "pending")
    throw new InvalidInputError(
      `Only pending accounts can be approved (current status: ${user.status})`,
    );
  return saveChanges(user._id, { status: "active" });
}

/**
 * Decline a pending account.
 */
export async function declineUser(id: string): Promise<PublicUser> {
  const user = await findUserById(id);
  if (user.status !== "pending")
    throw new InvalidInputError(
      `Only pending accounts can be declined (current status: ${user.status})`,
    );
  return saveChanges(user._id, { status: "declined" });
}

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

/**
 * Check an email and password. After 5 wrong passwords in a row the account is
 * locked for 15 minutes. The same error is used for an unknown email and a
 * wrong password, so nobody can find out which emails have accounts.
 */
export async function loginUser(
  email: unknown,
  password: unknown,
): Promise<PublicUser> {
  if (
    typeof email !== "string" ||
    !email ||
    typeof password !== "string" ||
    !password
  )
    throw new InvalidInputError(
      "Invalid input: email and password are required",
    );
  if (!usersCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const wrong = new AppError(
    401,
    "invalid_credentials",
    "Wrong email or password",
  );

  try {
    const user = await usersCollection.findOne({
      email: normalizeEmail(email),
    });
    if (!user) throw wrong;

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60000,
      );
      throw new AppError(
        429,
        "account_locked",
        `Too many failed attempts. Try again in ${minutes} minute(s)`,
      );
    }

    if (!(await bcrypt.compare(password, user.passwordHash))) {
      const updated = await usersCollection.findOneAndUpdate(
        { _id: user._id },
        { $inc: { failedLoginAttempts: 1 } },
        { returnDocument: "after" },
      );
      if (updated && (updated.failedLoginAttempts ?? 0) >= MAX_FAILED_LOGINS)
        await usersCollection.updateOne(
          { _id: user._id },
          {
            $set: {
              failedLoginAttempts: 0,
              lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000),
            },
          },
        );
      throw wrong;
    }

    // Status is checked only after the password is right
    if (user.status === "pending")
      throw new AppError(
        403,
        "email_not_verified",
        "The email is not verified. Sign up again to get a new code",
      );
    if (user.status === "declined")
      throw new AppError(403, "account_declined", "This account was declined");

    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { failedLoginAttempts: 0 }, $unset: { lockedUntil: "" } },
    );
    return toPublicUser(user);
  } catch (err: unknown) {
    if (err instanceof AppError || err instanceof InvalidInputError) throw err;
    throw new DatabaseError(
      "Database error: unable to log in" +
        (err instanceof Error ? "; " + err.message : ""),
    );
  }
}

/**
 * Activate an account after its email code was accepted. The account whose
 * email is ADMIN_EMAIL becomes an admin here, not at sign up, so only the
 * person who can read that mailbox can become the first admin.
 */
export async function activateUser(id: string): Promise<PublicUser> {
  const user = await findUserById(id);
  if (user.status === "declined")
    throw new AppError(403, "account_declined", "This account was declined");
  if (user.status === "active") return toPublicUser(user);

  return saveChanges(
    user._id,
    isFirstAdmin(user.email)
      ? { status: "active", role: "admin" }
      : { status: "active" },
  );
}

/**
 * Promote or demote a user. The first admin's role can't be changed.
 */
export async function changeUserRole(
  id: string,
  role: unknown,
): Promise<PublicUser> {
  if (!isAssignableRole(role))
    throw new InvalidInputError(
      `Invalid input: role must be one of ${ASSIGNABLE_ROLES.join(", ")}`,
    );

  const user = await findUserById(id);
  if (isFirstAdmin(user.email))
    throw new InvalidInputError("The first admin's role cannot be changed");

  return saveChanges(user._id, { role });
}

//#endregion

//#region Delete functions

export async function deleteUserById(id: string): Promise<PublicUser> {
  const user = await findUserById(id);
  if (isFirstAdmin(user.email))
    throw new InvalidInputError("The first admin account cannot be deleted");

  try {
    const result = await usersCollection.deleteOne({ _id: user._id });
    if (!result.acknowledged)
      throw new InvalidInputError(`unable to delete user ${id}`);
    return toPublicUser(user);
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new DatabaseError(`Delete User Error: ${err.message}`);
    else throw new Error(`Unknown error: ${err}`);
  }
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

export function getCollection(): Collection<User> {
  if (!usersCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return usersCollection;
}

//#region Helpers

function toPublicUser(user: User): PublicUser {
  const { passwordHash, failedLoginAttempts, lockedUntil, ...rest } = user;
  return rest;
}

function isValidStatus(value: unknown): value is User["status"] {
  return USER_STATUSES.some((s) => s === value);
}

function isAssignableRole(value: unknown): value is User["role"] {
  return ASSIGNABLE_ROLES.some((r) => r === value);
}

/**
 * Find a user by id string. Throws InvalidInputError for a bad or unknown id.
 */
async function findUserById(id: string): Promise<WithId<User>> {
  if (!usersCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!id) throw new InvalidInputError("Invalid input: must enter a user id");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const user = await usersCollection.findOne({ _id: objectId });
    if (!user)
      throw new InvalidInputError("No user found with the provided id");
    return user;
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    else
      throw new DatabaseError(
        `Database Error: issue when trying to retrieve user with id ${id}`,
      );
  }
}

/**
 * Apply changes to one user and return the updated public version.
 */
async function saveChanges(
  objectId: ObjectId,
  changes: Partial<Omit<User, "_id" | "createdAt" | "updatedAt">>,
): Promise<PublicUser> {
  const updated = await usersCollection.findOneAndUpdate(
    { _id: objectId },
    { $set: { ...changes, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!updated) throw new DatabaseError("Unable to update the user");
  return toPublicUser(updated);
}

//#endregion
