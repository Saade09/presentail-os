/**
 * AI opportunity qualifier — deterministic scoring without an external LLM call.
 *
 * Each opportunity is scored on four dimensions:
 *   - domainAuthority (40%) — DA 0-100, direct mapping
 *   - spamPenalty     (30%) — higher spam score lowers this component
 *   - traffic         (20%) — normalised to 50K/mo = 100
 *   - marketFit       (10%) — UAE/LB-targeted markets score highest
 *
 * Returns a composite 0–100 score, a human-readable explanation, per-component
 * numeric scores, and a string marketFitAssessment for display in the UI.
 */

export interface QualifierInput {
  domainAuthority: number | null;
  spamScore: number | null;
  estimatedTraffic: number | null;
  market: string;
  opportunityType: string | null;
  domain: string;
}

export interface QualifierScoreComponents {
  domainAuthority: number;
  spamPenalty: number;
  traffic: number;
  marketFit: number;
  marketFitAssessment: string;
}

export interface QualifierOutput {
  score: number;
  explanation: string;
  scoreComponents: QualifierScoreComponents;
}

export function aiQualifyOpportunity(input: QualifierInput): QualifierOutput {
  const da = input.domainAuthority != null ? Number(input.domainAuthority) : 0;
  const spam = input.spamScore != null ? Number(input.spamScore) : 0;
  const traffic = input.estimatedTraffic != null ? Number(input.estimatedTraffic) : 0;

  const daScore = Math.min(100, Math.max(0, da));
  const spamPenalty = Math.max(0, Math.min(100, 100 - spam * 2));
  const trafficScore = Math.min(100, (traffic / 50_000) * 100);

  const market = (input.market ?? "").toLowerCase();
  let marketFitScore = 50;
  let marketFitAssessment = "Moderate — market alignment unclear";
  if (market === "uae" || market === "ae") {
    marketFitScore = 90;
    marketFitAssessment = "Strong — UAE market directly targeted";
  } else if (market === "lb" || market === "lebanon") {
    marketFitScore = 85;
    marketFitAssessment = "Strong — Lebanon market directly targeted";
  } else if (market === "global") {
    marketFitScore = 65;
    marketFitAssessment = "Moderate — global reach with regional exposure potential";
  }

  const score = Math.round(
    daScore * 0.40 +
    spamPenalty * 0.30 +
    trafficScore * 0.20 +
    marketFitScore * 0.10,
  );

  const parts: string[] = [];
  if (da >= 50) parts.push(`high domain authority (DA ${da.toFixed(0)})`);
  else if (da >= 25) parts.push(`moderate domain authority (DA ${da.toFixed(0)})`);
  else parts.push(`low domain authority (DA ${da.toFixed(0)})`);

  if (spam <= 10) parts.push("low spam risk");
  else if (spam <= 30) parts.push("moderate spam risk");
  else parts.push(`elevated spam score (${spam.toFixed(0)}/100)`);

  if (traffic >= 10_000) parts.push(`strong traffic (~${Math.round(traffic / 1_000)}K/mo)`);
  else if (traffic >= 1_000) parts.push(`modest traffic (~${Math.round(traffic / 1_000)}K/mo)`);
  else if (traffic > 0) parts.push("low traffic");
  else parts.push("unknown traffic");

  const explanation =
    `${parts.join(", ")}. ${marketFitAssessment}.`.charAt(0).toUpperCase() +
    `${parts.join(", ")}. ${marketFitAssessment}.`.slice(1);

  return {
    score,
    explanation,
    scoreComponents: {
      domainAuthority: Math.round(daScore),
      spamPenalty: Math.round(spamPenalty),
      traffic: Math.round(trafficScore),
      marketFit: Math.round(marketFitScore),
      marketFitAssessment,
    },
  };
}
