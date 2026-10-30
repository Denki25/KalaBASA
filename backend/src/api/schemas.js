import { z } from "zod";
import { DOCUMENT_TYPES, FINDING_STATUSES } from "kalabasa-contract/schemas.js";

export const CreateApplicationResponse = z.object({ id: z.string() });
export const ApplicationSummary = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string(),
  created_at: z.string(),
  open_findings: z.number().int().nonnegative(),
  total_findings: z.number().int().nonnegative(),
});
export const ApplicationsResponse = z.array(ApplicationSummary);
export const ActivityItem = z.object({
  application_id: z.string(),
  action: z.string(),
  text: z.string(),
  timestamp: z.string(),
});
export const ActivityResponse = z.array(ActivityItem);
export const Stats = z.object({
  pending: z.number().int().nonnegative(),
  processed_today: z.number().int().nonnegative(),
  flagged: z.number().int().nonnegative(),
});
export const FindingUpdate = z.object({
  status: z.enum(FINDING_STATUSES),
  reviewer_note: z.string().nullable().optional(),
});
export const Requirements = z.object({
  lgu: z.object({
    id: z.string(),
    name: z.string(),
    province: z.string(),
    application_type: z.string(),
    note: z.string(),
  }),
  required_documents: z.array(z.object({
    rule_id: z.string(),
    document: z.enum(DOCUMENT_TYPES),
    label: z.string(),
    required: z.boolean(),
  })),
  required_fields: z.array(z.object({
    rule_id: z.string(),
    document: z.enum(DOCUMENT_TYPES),
    field: z.string(),
    severity: z.enum(["high", "medium", "low"]),
    description: z.string(),
  })),
  cross_document_checks: z.array(z.object({
    rule_id: z.string(),
    field: z.string(),
    documents: z.array(z.enum(DOCUMENT_TYPES)),
    severity: z.enum(["high", "medium", "low"]),
  })),
  do_not_compare: z.array(z.string()),
  normalization: z.record(z.string(), z.unknown()),
});
export const ApiError = z.object({ error: z.string() });
