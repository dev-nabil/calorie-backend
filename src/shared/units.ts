/**
 * BR-15: measurements are stored in metric and shown in the user's units.
 * Converting for display never changes the stored value.
 */
export const WEIGHT_UNITS = ['kg', 'lb'] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];
export const HEIGHT_UNITS = ['cm', 'ft_in'] as const;
export type HeightUnit = (typeof HEIGHT_UNITS)[number];
export const ENERGY_UNITS = ['kcal', 'kj'] as const;
export type EnergyUnit = (typeof ENERGY_UNITS)[number];
export const WATER_UNITS = ['ml', 'fl_oz'] as const;
export type WaterUnit = (typeof WATER_UNITS)[number];

export interface UnitPreferences {
  weight: WeightUnit;
  height: HeightUnit;
  energy: EnergyUnit;
  water: WaterUnit;
}

export const DEFAULT_UNITS: UnitPreferences = { weight: 'kg', height: 'cm', energy: 'kcal', water: 'ml' };

export const KG_PER_LB = 0.45359237;
export const CM_PER_INCH = 2.54;
export const KJ_PER_KCAL = 4.184;
export const ML_PER_FL_OZ = 29.5735295625; // US fluid ounce

export const kgToLb = (kg: number): number => kg / KG_PER_LB;
export const lbToKg = (lb: number): number => lb * KG_PER_LB;
export const kcalToKj = (kcal: number): number => kcal * KJ_PER_KCAL;
export const kjToKcal = (kj: number): number => kj / KJ_PER_KCAL;
export const mlToFlOz = (ml: number): number => ml / ML_PER_FL_OZ;
export const flOzToMl = (oz: number): number => oz * ML_PER_FL_OZ;

export function cmToFtIn(cm: number): { ft: number; in: number } {
  const totalIn = Math.round(cm / CM_PER_INCH);
  return { ft: Math.floor(totalIn / 12), in: totalIn % 12 };
}

export function ftInToCm(ft: number, inches: number): number {
  return (ft * 12 + inches) * CM_PER_INCH;
}
