import { InvalidInputError } from "../errors/InvalidInputError.js";
import * as eventModel from "./Event.js";
import * as awardModel from "./Award.js";
import * as teamModel from "./Team.js";
import * as scoreModel from "./Score.js";
import * as judgingAssignmentModel from "./JudgingAssignment.js";

export interface RankedTeam {
  rank: number;
  teamId: string;
  teamName: string;
  tableNumber?: number;
  // Average of the judges' totals
  total: number;
  criteriaAverages: { criterionId: string; average: number }[];
}

export interface AwardRanking {
  awardId: string;
  awardName: string;
  maxTotal: number;
  teams: RankedTeam[];
}

// Round, so decimal scores do not leave floating point noise
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Preliminary results, computed live from the scores.
 * Only scores a judge has submitted (or finalised) count; drafts never do.
 * A team's total for an award is the average of its judges' totals.
 * Teams that are not active (disqualified, withdrawn) are left out.
 * Teams with the same total share a rank (1, 1, 3).
 */
export async function getPreliminaryResults(
  eventId: string,
  awardId?: string,
): Promise<AwardRanking[]> {
  await eventModel.getEventById(eventId);

  let awards;
  if (awardId) {
    const award = await awardModel.getAwardById(awardId);
    if (award.eventId !== eventId)
      throw new InvalidInputError("Invalid input: award is not in this event");
    awards = [award];
  } else {
    awards = await awardModel
      .getCollection()
      .find({ eventId })
      .sort({ name: 1, _id: 1 })
      .toArray();
  }

  // A score counts only if its judge has submitted that team
  const submitted = await judgingAssignmentModel
    .getCollection()
    .find({ eventId, interimSubmittedAt: { $type: "date" } })
    .toArray();
  const submittedKeys = new Set(
    submitted.map((a) => `${a.judgeId}|${a.teamId}`),
  );

  const teams = await teamModel
    .getCollection()
    .find({ eventId, status: "active" })
    .toArray();
  const teamById = new Map(teams.map((t) => [t._id.toString(), t]));

  const scores = await scoreModel
    .getCollection()
    .find({ eventId, awardId: { $in: awards.map((a) => a._id.toString()) } })
    .toArray();

  return awards.map((award) => {
    const id = award._id.toString();

    // The submitted scores of each active team in this award
    const byTeam = new Map<string, typeof scores>();
    for (const s of scores) {
      if (s.awardId !== id) continue;
      if (!teamById.has(s.teamId)) continue;
      if (!submittedKeys.has(`${s.judgeId}|${s.teamId}`)) continue;
      byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);
    }

    const rows = [...byTeam].map(([teamId, list]) => {
      const team = teamById.get(teamId)!;
      const totals = list.map((s) =>
        s.criteriaScores.reduce((sum, c) => sum + c.value, 0),
      );
      return {
        teamId,
        teamName: team.name,
        tableNumber: team.tableNumber,
        total: round2(totals.reduce((a, b) => a + b, 0) / list.length),
        criteriaAverages: award.criteria.map((c) => {
          const values = list.map(
            (s) =>
              s.criteriaScores.find((x) => x.criterionId === c.id)?.value ?? 0,
          );
          return {
            criterionId: c.id,
            average: round2(values.reduce((a, b) => a + b, 0) / list.length),
          };
        }),
      };
    });

    rows.sort(
      (a, b) => b.total - a.total || a.teamName.localeCompare(b.teamName),
    );
    const ranked: RankedTeam[] = rows.map((r, i) => ({
      ...r,
      // Same total, same rank
      rank: i > 0 && r.total === rows[i - 1].total ? 0 : i + 1,
    }));
    for (let i = 0; i < ranked.length; i++)
      if (ranked[i].rank === 0) ranked[i].rank = ranked[i - 1].rank;

    return {
      awardId: id,
      awardName: award.name,
      maxTotal: round2(award.criteria.reduce((sum, c) => sum + c.max, 0)),
      teams: ranked,
    };
  });
}
