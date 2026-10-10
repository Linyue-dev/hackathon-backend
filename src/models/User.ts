import {
  MongoError,
  Db,
  MongoClient,
  Collection,
  ObjectId,
  WithId,
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
} from "../utils/validateUtils.js";

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
  role: "owner" | "admin" | "organizer" | "viewer";
  status: "pending" | "active" | "declined";
  createdAt: Date;
  updatedAt: Date;
}

// What we return to callers: never the password hash.
export type PublicUser = Omit<User, "passwordHash">;

export interface NewUserInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
}

const USER_STATUSES = ["pending", "active", "declined"] as const;
const ASSIGNABLE_ROLES = ["admin", "organizer", "viewer"] as const;
const SALT_ROUNDS = 10;

// Role and status are never changed through the normal update.
const UPDATABLE_FIELDS = ["firstName", "lastName", "phone"] as const;

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
 * Sign up a new account. It starts as a pending viewer, except the account
 * whose email matches OWNER_EMAIL, which becomes the active Owner.
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
    if (existing)
      throw new InvalidInputError(
        `An account with the email ${email} already exists`,
      );

    // The Owner is whoever signs up with the configured OWNER_EMAIL,
    // but only while no Owner exists yet (there is only ever one Owner).
    const ownerEmail = process.env.OWNER_EMAIL;
    const matchesOwnerEmail =
      !!ownerEmail && normalizedEmail === normalizeEmail(ownerEmail);
    const ownerExists = matchesOwnerEmail
      ? (await usersCollection.findOne({ role: "owner" })) !== null
      : false;
    const isOwner = matchesOwnerEmail && !ownerExists;

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const now = new Date();
    const user: User = {
      firstName,
      lastName,
      email: normalizedEmail,
      passwordHash,
      phone,
      role: isOwner ? "owner" : "viewer",
      status: isOwner ? "active" : "pending",
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
 * Get users, optionally only those with one status (e.g. "pending" approvals).
 */
export async function getAllUsers(
  filter: { status?: string } = {},
): Promise<PublicUser[]> {
  if (!usersCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (filter.status !== undefined && !isValidStatus(filter.status))
    throw new InvalidInputError(
      `Invalid input: status '${filter.status}' is not valid`,
    );

  try {
    const users = await usersCollection
      .find(filter.status ? { status: filter.status } : {})
      .toArray();
    return users.map(toPublicUser);
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

/**
 * Promote or demote a user. The Owner role can't be given or changed.
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
  if (user.role === "owner")
    throw new InvalidInputError("The Owner's role cannot be changed");

  return saveChanges(user._id, { role });
}

//#endregion

//#region Delete functions

export async function deleteUserById(id: string): Promise<PublicUser> {
  const user = await findUserById(id);
  if (user.role === "owner")
    throw new InvalidInputError("The Owner account cannot be deleted");

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
  const { passwordHash, ...rest } = user;
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
