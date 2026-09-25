/**
 * Placeholder query helpers for maintenance/plant-floor operations.
 * Trainees build these — see APP_WORKSHOP.md.
 */

import type { AppDb } from '../index.js';

export async function worstAtriskLine(
  _db: AppDb,
): Promise<{
  lineId: string;
  plantId: string;
  lineName: string;
  failureRiskScore: number;
  downtimeExposureUsd: number;
} | null> {
  throw new Error('Not implemented — trainee builds this');
}

export async function getLineStatus(
  _db: AppDb,
  _lineId: string,
): Promise<{
  lineId: string;
  plantId: string;
  lineName: string;
  failureRiskScore: number;
  downtimeExposureUsd: number;
  partLocal: boolean;
  partId: string | null;
  partLeadTimeDays: number;
} | null> {
  throw new Error('Not implemented — trainee builds this');
}

export async function getRecommendation(
  _db: AppDb,
  _lineId: string,
): Promise<{
  lineId: string;
  recommendedAction: 'pull_now' | 'run_to_shift_end' | 'expedite_parts_and_run';
  predictedDowntimeCostUsd: number;
  actionRanking: Array<{
    action: string;
    costUsd: number;
    predictedCostAvoided: number;
    netValue: number;
  }>;
} | null> {
  throw new Error('Not implemented — trainee builds this');
}

export async function searchParts(
  _db: AppDb,
  _query: string,
): Promise<
  Array<{
    partId: string;
    partName: string;
    partCategory: string;
    partLocal: boolean;
    leadTimeDays: number;
  }>
> {
  throw new Error('Not implemented — trainee builds this');
}

export async function recordMaintenanceAction(
  _db: AppDb,
  _args: {
    lineId: string;
    actionType: 'pull_now' | 'run_to_shift_end' | 'expedite_parts_and_run';
    partId: string | null;
    draftedWo: string;
    predictedDowntimeCostAvoidsUsd: number | null;
    userEmail: string;
  },
): Promise<{ actionId: string }> {
  throw new Error('Not implemented — trainee builds this');
}
