import { MongoError, Db, MongoClient, Collection, ObjectId } from "mongodb";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { DatabaseError } from "../errors/DatabaseError.js";
import * as awardModel from "./Award.js";

let client: MongoClient;
export let judgingFormsCollection: Collection<JudgingForm>;

const collectionName: string = "judgingForms";

export interface CriteriaItem {
  id: string;
  category: string;
  question: string;
  weight: number;
  max: number;
}

// One form per award. The form is created the first time it is saved.
export interface JudgingForm {
  _id?: ObjectId;
  awardId: string;
  instructions: string;
  criteria: CriteriaItem[];
  createdAt: Date;
  updatedAt: Date;
}

// What GET returns for an award that has no saved form yet
export type EmptyForm = Pick<
  JudgingForm,
  "awardId" | "instructions" | "criteria"
>;

export interface FormInput {
  criteria: unknown;
  instructions?: unknown;
}

/**
 * Connect to the database and prepare the judgingForms collection.
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
    judgingFormsCollection = db.collection(collectionName);
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

//#region Get functions

/**
 * Get the judging form of an award. If no form was saved yet,
 * return an empty one (nothing is stored).
 */
export async function getFormByAwardId(
  awardId: string,
): Promise<JudgingForm | EmptyForm> {
  if (!judgingFormsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  // Throws InvalidInputError if the award does not exist
  await awardModel.getAwardById(awardId);

  try {
    const form = await judgingFormsCollection.findOne({ awardId });
    return form ?? { awardId, instructions: "", criteria: [] };
  } catch (err) {
    throw new DatabaseError(
      `Database Error: issue when trying to retrieve the form of award ${awardId}`,
    );
  }
}

//#endregion

//#region Update functions

/**
 * Replace the criteria list and instructions of an award's form.
 * The form is created if it does not exist yet.
 */
export async function replaceFormForAward(
  awardId: string,
  input: FormInput,
): Promise<JudgingForm> {
  if (!judgingFormsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const criteria = normalizeCriteria(input.criteria);

  const { instructions } = input;
  if (instructions !== undefined && typeof instructions !== "string")
    throw new InvalidInputError("Invalid input: instructions must be a string");

  // Throws InvalidInputError if the award does not exist
  await awardModel.getAwardById(awardId);

  const now = new Date();
  try {
    const saved = await judgingFormsCollection.findOneAndUpdate(
      { awardId },
      {
        $set: { criteria, instructions: instructions ?? "", updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (!saved) throw new DatabaseError("Unable to save the judging form");
    return saved;
  } catch (err: unknown) {
    if (err instanceof DatabaseError) throw err;
    else if (err instanceof Error)
      throw new DatabaseError(
        `Update JudgingForm Error: failed to save the form of award ${awardId}; ${err.message}`,
      );
    else throw new Error("Unknown error " + err);
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

export function getCollection(): Collection<JudgingForm> {
  if (!judgingFormsCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return judgingFormsCollection;
}

//#region Helpers

/**
 * Check every criteria item and give each one an id.
 * An id sent by the client is kept, so scores that point to it stay valid.
 */
export function normalizeCriteria(criteria: unknown): CriteriaItem[] {
  if (!Array.isArray(criteria))
    throw new InvalidInputError("Invalid input: criteria must be an array");

  const usedIds = new Set<string>();

  return criteria.map((item: unknown, index: number) => {
    const n = index + 1;
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new InvalidInputError(
        `Invalid input: criteria item ${n} must be an object`,
      );

    const { id, category, question, weight, max } = item as Record<
      string,
      unknown
    >;

    if (typeof category !== "string" || !category.trim())
      throw new InvalidInputError(
        `Invalid input: criteria item ${n} needs a category`,
      );
    if (typeof question !== "string" || !question.trim())
      throw new InvalidInputError(
        `Invalid input: criteria item ${n} needs a question`,
      );
    if (!isPositiveNumber(weight))
      throw new InvalidInputError(
        `Invalid input: criteria item ${n} needs a weight greater than 0`,
      );
    if (!isPositiveNumber(max))
      throw new InvalidInputError(
        `Invalid input: criteria item ${n} needs a max greater than 0`,
      );

    let itemId: string;
    if (id === undefined) itemId = new ObjectId().toHexString();
    else if (typeof id === "string" && id.trim()) itemId = id.trim();
    else
      throw new InvalidInputError(
        `Invalid input: criteria item ${n} id must be a non-empty string`,
      );

    if (usedIds.has(itemId))
      throw new InvalidInputError(
        `Invalid input: criteria id '${itemId}' is used more than once`,
      );
    usedIds.add(itemId);

    return {
      id: itemId,
      category: category.trim(),
      question: question.trim(),
      weight,
      max,
    };
  });
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

//#endregion
