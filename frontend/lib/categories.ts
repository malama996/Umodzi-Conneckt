/**
 * Canonical technician category system — single source of truth.
 *
 * All category strings in the application must come from this module.
 * Legacy names ("Mechanics", "ICT support", "Appliance repair") were renamed
 * to "Automotive", "ICT" and "Appliance Repair" during the V0.2 migration.
 */
/**
 * Canonical technician category system — single source of truth.
 *
 * All category strings in the application must come from this module.
 * Legacy names ("Mechanics", "ICT support", "Appliance repair") were renamed
 * to "Automotive", "ICT" and "Appliance Repair" during the V0.2 migration.
 */
export const technicianCategories = [
  'Plumbing',
  'Electrical',
  'Automotive',
  'HVAC',
  'Appliance Repair',
  'Refrigeration',
  'Electronics',
  'ICT',
  'Handyman',
] as const;

export type TechnicianCategory = (typeof technicianCategories)[number];

export function isTechnicianCategory(value: string): value is TechnicianCategory {
  return (technicianCategories as readonly string[]).includes(value);
}
