import { MongoError, Db, MongoClient, Collection, ObjectId } from "mongodb";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { DatabaseError } from "../errors/DatabaseError.js";
import { AppError } from "../errors/AppError.js";
import * as eventModel from "./Event.js";
import * as awardModel from "./Award.js";
import * as teamModel from "./Team.js";

let client: MongoClient;
export let sponsorChoiceCollection: Collection<SponsorChoice>;

const collectionName: string = "sponsorchoices";

// One placing: this team has this rank in this award.
// Final results are the admin's placings, so source is "admin".
export interface SponsorChoice {
  _id?: ObjectId;
  eventId: string;
  awardId: string;
  teamId: string;
  // 1 is the winner. Teams can share a rank
  rank: number;
  source: "computed" | "admin" | "sponsor";
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FinalPlacement {
  teamId: string;
  teamName: string;
  rank: number;
  note?: string;
}

export interface AwardPlacements {
  awardId: string;
  awardName: string;
  placements: FinalPlacement[];
}

/**
 * Connect to the database and prepare the sponsorchoices collection.
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
    sponsorChoiceCollection = db.collection(collectionName);
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

//#region Final results

/**
 * Set the final placings of one award. The list replaces the admin's earlier
 * placings of this award, so send the whole list; an empty list clears it.
 * Everything is checked before anything is saved. Not allowed once the
 * results are published.
 */
export async function setFinalPlacements(
  eventId: string,
  awardId: string,
  body: unknown,
): Promise<AwardPlacements> {
  const event = await eventModel.getEventById(eventId);
  if (event.resultsPublishedAt)
    throw new AppError(
      409,
      "results_published",
      "The results are published, so the placings are locked",
    );

  const award = await awardModel.getAwardById(awardId);
  if (award.eventId !== eventId)
    throw new InvalidInputError("Invalid input: award is not in this event");

  const placements = (body as { placements?: unknown } | null | undefined)
    ?.placements;
  if (!Array.isArray(placements))
    throw new InvalidInputError("Invalid input: placements must be an array");

  const now = new Date();
  const docs: SponsorChoice[] = [];
  const seen = new Set<string>();
  for (const [i, item] of placements.entries()) {
    const p = item as { teamId?: unknown; rank?: unknown; note?: unknown };
    const where = `placement ${i + 1}`;
    if (typeof p?.teamId !== "string")
      throw new InvalidInputError(`Invalid input: ${where} needs a teamId`);
    if (seen.has(p.teamId))
      throw new InvalidInputError(
        `Invalid input: ${where} repeats a team (a team can place only once)`,
      );
    seen.add(p.teamId);
    if (typeof p.rank !== "number" || !Number.isInteger(p.rank) || p.rank < 1)
      throw new InvalidInputError(
        `Invalid input: ${where} rank must be a positive whole number`,
      );
    if (p.note !== undefined && typeof p.note !== "string")
      throw new InvalidInputError(
        `Invalid input: ${where} note must be a string`,
      );

    // Throws InvalidInputError if the team does not exist
    const team = await teamModel.getTeamById(p.teamId);
    if (team.eventId !== eventId)
      throw new InvalidInputError(
        `Invalid input: ${where} team is not in this event`,
      );
    if (team.status !== "active")
      throw new InvalidInputError(`Invalid input: ${where} team is not active`);

    docs.push({
      eventId,
      awardId,
      teamId: p.teamId,
      rank: p.rank,
      source: "admin",
      note: p.note,
      createdAt: now,
      updatedAt: now,
    });
  }

  try {
    await getCollection().deleteMany({ eventId, awardId, source: "admin" });
    if (docs.length > 0) await getCollection().insertMany(docs);
  } catch (err: unknown) {
    throw new DatabaseError(
      "Database error: unable to save the placings" +
        (err instanceof Error ? "; " + err.message : ""),
    );
  }

  return (await loadPlacements(eventId, [award]))[0];
}

/**
 * The current final placings of every award of the event, and whether the
 * results are published. Awards without placings have an empty list.
 */
export async function getFinalResults(eventId: string): Promise<{
  resultsPublishedAt?: Date;
  awards: AwardPlacements[];
}> {
  const event = await eventModel.getEventById(eventId);
  const awards = await awardModel
    .getCollection()
    .find({ eventId })
    .sort({ name: 1, _id: 1 })
    .toArray();
  return {
    resultsPublishedAt: event.resultsPublishedAt,
    awards: await loadPlacements(eventId, awards),
  };
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

export function getCollection(): Collection<SponsorChoice> {
  if (!sponsorChoiceCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return sponsorChoiceCollection;
}

//#region Helpers

// The admin's placings of the given awards, best rank first
async function loadPlacements(
  eventId: string,
  awards: { _id: ObjectId; name: string }[],
): Promise<AwardPlacements[]> {
  const docs = await getCollection()
    .find({
      eventId,
      source: "admin",
      awardId: { $in: awards.map((a) => a._id.toString()) },
    })
    .sort({ rank: 1, _id: 1 })
    .toArray();
  const teams = await teamModel.getCollection().find({ eventId }).toArray();
  const teamName = new Map(teams.map((t) => [t._id.toString(), t.name]));

  return awards.map((award) => ({
    awardId: award._id.toString(),
    awardName: award.name,
    placements: docs
      .filter((d) => d.awardId === award._id.toString())
      .map((d) => ({
        teamId: d.teamId,
        teamName: teamName.get(d.teamId) ?? "",
        rank: d.rank,
        note: d.note,
      })),
  }));
}

//#endregion
