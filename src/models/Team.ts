import {
  MongoError,
  Db,
  MongoClient,
  Collection,
  ObjectId,
  WithId,
} from "mongodb";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { DatabaseError } from "../errors/DatabaseError.js";
import {
  isValidEmail,
  normalizeEmail,
  pickFields,
} from "../utils/validateUtils.js";
import * as eventModel from "./Event.js";

let client: MongoClient;
export let teamsCollection: Collection<Team>;

const collectionName: string = "teams";

export interface TeamMember {
  firstName: string;
  lastName: string;
  email: string;
  program: string;
  year: number;
  school?: string;
}

export interface Team {
  _id?: ObjectId;
  eventId: string;
  name: string;
  tableNumber?: number;
  location?: string;
  members: TeamMember[];
  schools: string[];
  projectUrl?: string;
  projectDescription?: string;
  status: "active" | "disqualified" | "withdrawn";
  eligibilities: string[];
  verifiedEligibilities: string[];
  appliedAwardIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTeamInput {
  eventId: string;
  name: string;
  tableNumber?: number;
  location?: string;
  members?: TeamMember[];
  schools?: string[];
  projectUrl?: string;
  projectDescription?: string;
  status?: string;
  eligibilities?: string[];
  appliedAwardIds?: string[];
}

const TEAM_STATUSES = ["active", "disqualified", "withdrawn"] as const;

const UPDATABLE_FIELDS = [
  "name",
  "tableNumber",
  "location",
  "members",
  "schools",
  "projectUrl",
  "projectDescription",
  "status",
  "eligibilities",
  "verifiedEligibilities",
  "appliedAwardIds",
] as const;

/**
 * Connect to the database and prepare the teams collection.
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
    teamsCollection = db.collection(collectionName);
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
 * Add a new team to an event. verifiedEligibilities always starts empty:
 * only staff can confirm eligibilities later.
 */
export async function addTeam(input: NewTeamInput): Promise<Team> {
  if (!teamsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const {
    eventId,
    name,
    tableNumber,
    location,
    projectUrl,
    projectDescription,
  } = input;
  const members = input.members ?? [];
  const schools = input.schools ?? [];
  const eligibilities = input.eligibilities ?? [];
  const appliedAwardIds = input.appliedAwardIds ?? [];
  const status = input.status ?? "active";

  if (!eventId) throw new InvalidInputError("Invalid input: eventId is empty");
  if (!name) throw new InvalidInputError("Invalid input: team name is empty");
  if (!isValidStatus(status))
    throw new InvalidInputError(
      `Invalid input: status '${status}' is not valid`,
    );
  if (tableNumber !== undefined) validateTableNumber(tableNumber);
  validateMembers(members);
  validateStringArray(schools, "schools");
  validateStringArray(eligibilities, "eligibilities");
  validateStringArray(appliedAwardIds, "appliedAwardIds");

  // Throws InvalidInputError if the event does not exist
  await eventModel.getEventById(eventId);

  if (tableNumber !== undefined)
    await assertTableNumberFree(eventId, tableNumber);

  const now = new Date();
  const team: Team = {
    eventId,
    name,
    tableNumber,
    location,
    members: normalizeMembers(members),
    schools,
    projectUrl,
    projectDescription,
    status,
    eligibilities,
    verifiedEligibilities: [],
    appliedAwardIds,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await teamsCollection.insertOne(team);
    return team;
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new DatabaseError(
        "Database error: unable to insert team; " + err.message,
      );
    } else {
      throw new Error("Unknown error: " + err);
    }
  }
}

//#endregion

//#region Get functions

export async function getTeamById(id: string): Promise<WithId<Team>> {
  if (!teamsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!id) throw new InvalidInputError("Invalid input: must enter a team id");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Get Team: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const result = await teamsCollection.findOne({ _id: objectId });
    if (!result) {
      throw new InvalidInputError("No team found with the provided id");
    }
    return result;
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    else
      throw new DatabaseError(
        `Database Error: issue when trying to retrieve team with id ${id}`,
      );
  }
}

/**
 * Get all teams, optionally only those of one event.
 */
export async function getAllTeams(eventId?: string): Promise<WithId<Team>[]> {
  if (!teamsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  try {
    const cursor = teamsCollection.find(eventId ? { eventId } : {});
    return await cursor.toArray();
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve teams",
    );
  }
}

//#endregion

//#region Update functions

export async function updateTeamById(
  id: string,
  updates: Partial<Omit<Team, "_id" | "eventId" | "createdAt" | "updatedAt">>,
): Promise<Team> {
  if (!teamsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Update Team: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  const cleanUpdates = pickFields(updates, UPDATABLE_FIELDS);
  if (Object.keys(cleanUpdates).length === 0)
    throw new InvalidInputError(
      "Update team error: at least one valid field must be provided",
    );

  if (cleanUpdates.name !== undefined && !cleanUpdates.name)
    throw new InvalidInputError("Invalid input: team name is empty");
  if (cleanUpdates.status !== undefined && !isValidStatus(cleanUpdates.status))
    throw new InvalidInputError(
      `Invalid input: status '${String(cleanUpdates.status)}' is not valid`,
    );
  if (cleanUpdates.tableNumber !== undefined)
    validateTableNumber(cleanUpdates.tableNumber);
  if (cleanUpdates.members !== undefined) {
    validateMembers(cleanUpdates.members);
    cleanUpdates.members = normalizeMembers(cleanUpdates.members);
  }
  if (cleanUpdates.schools !== undefined)
    validateStringArray(cleanUpdates.schools, "schools");
  if (cleanUpdates.eligibilities !== undefined)
    validateStringArray(cleanUpdates.eligibilities, "eligibilities");
  if (cleanUpdates.verifiedEligibilities !== undefined)
    validateStringArray(
      cleanUpdates.verifiedEligibilities,
      "verifiedEligibilities",
    );
  if (cleanUpdates.appliedAwardIds !== undefined)
    validateStringArray(cleanUpdates.appliedAwardIds, "appliedAwardIds");

  try {
    const oldTeam = await teamsCollection.findOne<Team>({ _id: objectId });
    if (!oldTeam)
      throw new InvalidInputError(
        `The team you are trying to update doesn't exist (id ${id})`,
      );

    if (
      cleanUpdates.tableNumber !== undefined &&
      cleanUpdates.tableNumber !== oldTeam.tableNumber
    )
      await assertTableNumberFree(
        oldTeam.eventId,
        cleanUpdates.tableNumber,
        objectId,
      );

    const newTeam: Team = {
      ...oldTeam,
      ...cleanUpdates,
      updatedAt: new Date(),
    };

    // Staff can only confirm eligibilities the team actually claimed
    const unclaimed = newTeam.verifiedEligibilities.filter(
      (tag) => !newTeam.eligibilities.includes(tag),
    );
    if (unclaimed.length > 0)
      throw new InvalidInputError(
        `Invalid input: cannot verify eligibilities the team did not claim: ${unclaimed.join(", ")}`,
      );

    const replaced = await teamsCollection.findOneAndReplace(
      { _id: objectId },
      newTeam,
    );
    if (!replaced) throw new Error();
    return newTeam;
  } catch (err: unknown) {
    if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new DatabaseError(
        `Update Team Error: failed to update team ${id}; ${err.message}`,
      );
    else throw new Error("Unknown error " + err);
  }
}

//#endregion

//#region Delete functions

export async function deleteTeamById(id: string): Promise<Team> {
  if (!teamsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Delete Team: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const teamToDelete = await teamsCollection.findOne<Team>({
      _id: objectId,
    });
    if (!teamToDelete)
      throw new InvalidInputError(
        `The team you were trying to delete doesn't exist (id ${id})`,
      );

    const result = await teamsCollection.deleteOne({ _id: objectId });
    if (!result.acknowledged)
      throw new InvalidInputError(`unable to delete team ${id}`);

    return teamToDelete;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    else if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new Error(`Unexpected error: ${err.message}`);
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

export function getCollection(): Collection<Team> {
  if (!teamsCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return teamsCollection;
}

//#region Helpers
function isValidStatus(value: unknown): value is Team["status"] {
  return TEAM_STATUSES.some((s) => s === value);
}

function validateStringArray(value: unknown, fieldName: string): void {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    throw new InvalidInputError(
      `Invalid input: ${fieldName} must be an array of strings`,
    );
}

function validateTableNumber(value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new InvalidInputError(
      "Invalid input: tableNumber must be a positive integer",
    );
}

function validateMembers(members: TeamMember[]): void {
  if (!Array.isArray(members))
    throw new InvalidInputError("Invalid input: members must be an array");
  for (const m of members) {
    if (!m || !m.firstName || !m.lastName)
      throw new InvalidInputError(
        "Invalid input: each member needs firstName and lastName",
      );
    if (!m.email || !isValidEmail(m.email))
      throw new InvalidInputError(
        `Invalid input: member email '${m?.email}' is not valid`,
      );
    if (!m.program)
      throw new InvalidInputError("Invalid input: each member needs a program");
    if (typeof m.year !== "number" || !Number.isFinite(m.year))
      throw new InvalidInputError(
        "Invalid input: each member needs a numeric year",
      );
  }
}

function normalizeMembers(members: TeamMember[]): TeamMember[] {
  return members.map((m) => ({ ...m, email: normalizeEmail(m.email) }));
}

/**
 * Make sure no other team in the same event already uses this table number.
 * @param excludeId the team being updated, so it does not conflict with itself.
 */
async function assertTableNumberFree(
  eventId: string,
  tableNumber: number,
  excludeId?: ObjectId,
): Promise<void> {
  const existing = await teamsCollection.findOne({
    eventId,
    tableNumber,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });
  if (existing)
    throw new InvalidInputError(
      `Table number ${tableNumber} is already used by another team in this event`,
    );
}

//#endregion
