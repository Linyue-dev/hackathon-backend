import { parse } from "csv-parse/sync";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import * as eventModel from "./Event.js";
import * as teamModel from "./Team.js";
import * as awardModel from "./Award.js";
import * as teamEntryModel from "./TeamEntry.js";
import type { Team } from "./Team.js";
import type { WithId } from "mongodb";

// What changed in the last Devpost import of an event.
// Saved on the event; a new import replaces it.
export interface ImportDiffs {
  importedAt: Date;
  added: { devpostId: string; name: string }[];
  updated: { devpostId: string; name: string; fields: string[] }[];
  // Imported before, but not in this CSV. They are not deleted.
  missing: { devpostId: string; name: string; teamId: string }[];
  // Prize names in the CSV that match no award of the event
  unknownPrizes: string[];
}

// The CSV columns this import reads
interface CsvRow {
  project_id?: string;
  project_title?: string;
  table_number?: string;
  submission_url?: string;
  project_status?: string;
  about_project?: string;
  opt_in_prizes?: string;
  team_schools?: string;
}

const REQUIRED_COLUMNS = ["project_id", "project_title"] as const;
const UPDATED_FIELDS = [
  "name",
  "tableNumber",
  "projectUrl",
  "projectDescription",
  "schools",
] as const;

/**
 * Import the teams of an event from a Devpost CSV export.
 * - Draft projects are skipped.
 * - A team is matched to an earlier import by project_id (devpostId):
 *   a new one is created, an existing one is updated.
 * - Each prize in opt_in_prizes becomes a team entry when an award of the
 *   event has the same name (not case-sensitive). Other names are listed in
 *   unknownPrizes.
 * - Teams imported before but not in this CSV are only listed in missing.
 * The differences are saved on the event (GET lastImportDiffs).
 * Returns the teams of this CSV.
 */
export async function importTeamsFromCsv(
  eventId: string,
  csvText: unknown,
): Promise<WithId<Team>[]> {
  if (typeof csvText !== "string" || !csvText.trim())
    throw new InvalidInputError(
      "Invalid input: send the CSV text as the body (Content-Type: text/csv)",
    );

  // Throws InvalidInputError if the event does not exist
  await eventModel.getEventById(eventId);

  const rows = parseCsv(csvText).filter((r) => r.project_status !== "Draft");

  const existingTeams = await teamModel.getDevpostTeamsOfEvent(eventId);
  const teamsByDevpostId = new Map(existingTeams.map((t) => [t.devpostId, t]));

  const awards = await awardModel.getAwardsOfEvent(eventId);
  const awardsByName = new Map(
    awards.map((a) => [a.name.toLowerCase(), String(a._id)]),
  );

  const diffs: ImportDiffs = {
    importedAt: new Date(),
    added: [],
    updated: [],
    missing: [],
    unknownPrizes: [],
  };
  const importedTeams: WithId<Team>[] = [];

  for (const row of rows) {
    const devpostId = row.project_id!.trim();
    const fields = toTeamFields(row);
    const oldTeam = teamsByDevpostId.get(devpostId);

    let team: WithId<Team>;
    if (oldTeam) {
      const changes = getChanges(oldTeam, fields);
      const changedFields = Object.keys(changes);
      if (changedFields.length > 0) {
        team = (await teamModel.updateTeamById(
          String(oldTeam._id),
          changes,
        )) as WithId<Team>;
        diffs.updated.push({
          devpostId,
          name: team.name,
          fields: changedFields,
        });
      } else {
        team = oldTeam;
      }
    } else {
      // insertOne adds the _id to the saved object
      team = (await teamModel.addTeam({
        ...fields,
        eventId,
        source: "devpost",
        devpostId,
      })) as WithId<Team>;
      diffs.added.push({ devpostId, name: team.name });
    }
    importedTeams.push(team);

    // Team entries for the prizes the team applied for
    const teamId = String(team._id);
    const entries = await teamEntryModel.getEntriesOfTeam(teamId);
    const appliedAwardIds = new Set(entries.map((e) => e.awardId));

    for (const prize of splitList(row.opt_in_prizes)) {
      const awardId = awardsByName.get(prize.toLowerCase());
      if (!awardId) {
        if (!diffs.unknownPrizes.includes(prize))
          diffs.unknownPrizes.push(prize);
      } else if (!appliedAwardIds.has(awardId)) {
        await teamEntryModel.addTeamEntry(teamId, awardId);
        appliedAwardIds.add(awardId);
      }
    }
  }

  const csvDevpostIds = new Set(rows.map((r) => r.project_id!.trim()));
  for (const t of existingTeams) {
    if (t.devpostId && !csvDevpostIds.has(t.devpostId))
      diffs.missing.push({
        devpostId: t.devpostId,
        name: t.name,
        teamId: String(t._id),
      });
  }

  await eventModel.setLastImportDiffs(eventId, diffs);
  return importedTeams;
}

//#region Helpers

/**
 * Read the CSV text into rows. Throws InvalidInputError if the text is not
 * a valid CSV, a required column is missing, or a row has no project_id or
 * project_title.
 */
function parseCsv(csvText: string): CsvRow[] {
  let rows: CsvRow[];
  try {
    rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
    }) as CsvRow[];
  } catch (err) {
    throw new InvalidInputError(
      "Invalid input: the CSV could not be read" +
        (err instanceof Error ? "; " + err.message : ""),
    );
  }

  if (rows.length === 0)
    throw new InvalidInputError("Invalid input: the CSV has no rows");

  for (const column of REQUIRED_COLUMNS) {
    if (!(column in rows[0]!))
      throw new InvalidInputError(
        `Invalid input: the CSV has no column '${column}'`,
      );
  }

  rows.forEach((r, i) => {
    if (!r.project_id?.trim() || !r.project_title?.trim())
      throw new InvalidInputError(
        `Invalid input: row ${i + 2} needs a project_id and a project_title`,
      );
  });

  return rows;
}

/** The team fields that come from one CSV row. Empty cells are left out. */
function toTeamFields(row: CsvRow) {
  const tableNumber = Number(row.table_number);
  return {
    name: row.project_title!.trim(),
    ...(row.table_number?.trim() &&
      Number.isInteger(tableNumber) &&
      tableNumber > 0 && { tableNumber }),
    ...(row.submission_url?.trim() && {
      projectUrl: row.submission_url.trim(),
    }),
    ...(row.about_project?.trim() && {
      projectDescription: row.about_project.trim(),
    }),
    schools: splitList(row.team_schools),
  };
}

/** The fields whose CSV value is different from the saved team. */
function getChanges(
  oldTeam: Team,
  fields: ReturnType<typeof toTeamFields>,
): Partial<Team> {
  const changes: Partial<Team> = {};
  for (const key of UPDATED_FIELDS) {
    const newValue = (fields as Partial<Team>)[key];
    if (newValue === undefined) continue;
    if (JSON.stringify(newValue) !== JSON.stringify(oldTeam[key]))
      (changes as Record<string, unknown>)[key] = newValue;
  }
  return changes;
}

/** Split a Devpost list cell like "A | B | C" into trimmed, non-empty items. */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

//#endregion
