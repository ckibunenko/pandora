/** Known Bug Lab defects (overview §9). Descriptions, briefs, and solutions live in `bug-lab/`. */
export const BUG_LAB_DEFECTS = ["BUG-001", "BUG-002", "BUG-003"] as const;
export type DefectId = (typeof BUG_LAB_DEFECTS)[number];

/** Only dedicated Bug Lab databases may run a defect; development, QA, and demo databases never match. */
export const BUG_LAB_DATABASE = /^pandora_buglab(?:_[a-z0-9_]+)?$/;
