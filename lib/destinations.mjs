// Where each sheet lives. Table IDs are the ones in the Zapier spot-check instructions (section 3).
export const WORKBOOK = 'New Project.xlsx';

export const DESTINATIONS = Object.freeze({
  HR: { worksheet: 'HR', tableId: '{1D5EC622-A006-413E-9A29-A8AE8CDD9F47}' },
  POS: { worksheet: 'POS', tableId: '{B0F08E46-1C48-4685-A931-227662FF5D4E}' },
  Medical: { worksheet: 'Medical', tableId: '{AFDB7421-454A-4E04-BEF2-6668E1BD8A59}' },
  CRM: { worksheet: 'CRM', tableId: '{2654EC29-4158-4037-B1B8-F817F673A075}' },
  LMS: { worksheet: 'LMS', tableId: '{BCACC205-F03C-42D5-A8E4-FAD561CB45CD}' },
  'Legal PM': { worksheet: 'Legal PM', tableId: '{2272458B-9800-4B13-A38C-32276B44E5A6}' },
  PM: { worksheet: 'PM', tableId: '{380CAD62-C804-425E-8A43-082197A0BFEB}' },
  'Field Service': { worksheet: 'Field Service', tableId: '{68DF7856-3EC2-4DB5-8093-DA19B9EA3C13}' },
  Accounting: { worksheet: 'Accounting', tableId: '{1C35403C-4A98-430F-8BEF-3E37D806F3D1}' },
  CMMS: { worksheet: 'CMMS', tableId: '{DB970793-B89B-442E-9F49-34BCCBE7B0B7}' },
  'Property Management': { worksheet: 'Property Management', tableId: '{8C6DD64B-DACB-41EA-A1ED-BBED9F6567C2}' },
  EHS: { worksheet: 'EHS', tableId: '{3497D823-0957-4162-82FD-521D6C7A6B2C}' },
  ERP: { worksheet: 'ERP', tableId: '{34563F2D-55D2-4393-B731-D1C96F6A7EB8}' },
});

export const FLOW_NAMES = Object.freeze({
  WF1: 'Opportunity',
  WF2: 'First Cross',
  WF3: 'Recon',
  WF4: 'First Cross Recon',
  WF5: 'SaaS Outreach',
});

export const destinationFor = (sheet) => ({
  workbook: WORKBOOK,
  worksheet: DESTINATIONS[sheet]?.worksheet ?? sheet,
  tableId: DESTINATIONS[sheet]?.tableId ?? null,
});
