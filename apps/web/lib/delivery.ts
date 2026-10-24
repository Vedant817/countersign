import { FLAT_SHIPPING_MINOR, SHIPPING_CURRENCY } from '@countersign/gate'

export const COUNTRY_LABELS: Readonly<Record<string, string>> = {
  US: 'United States',
  CA: 'Canada',
  GB: 'United Kingdom',
  IE: 'Ireland',
  DE: 'Germany',
  FR: 'France',
  NL: 'Netherlands',
  ES: 'Spain',
  IT: 'Italy',
  IN: 'India',
  JP: 'Japan',
  AU: 'Australia',
  SG: 'Singapore',
  BR: 'Brazil',
  MX: 'Mexico',
}

export const DELIVERY_COUNTRIES = Object.keys(FLAT_SHIPPING_MINOR)
export { SHIPPING_CURRENCY }
