export type ApprovalTier = "read" | "modify" | "destructive";

export interface AuditLogEntry {
  id: number;
  timestamp: string;
  action: string;
  tier: ApprovalTier;
  approved: boolean;
  details: string;
}

export interface ApprovalRequest {
  action: string;
  tier: ApprovalTier;
  description: string;
  impact: string;
}
