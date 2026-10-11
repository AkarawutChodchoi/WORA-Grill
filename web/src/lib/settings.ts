import { useQuery } from '@tanstack/react-query';
import type { BranchSettings } from '@shared/settings';
import { get } from './api';

export interface BranchInfo {
  branch: { id: string; code: string; name: string; address: string | null; phone: string | null; taxId: string | null; timezone: string };
  settings: BranchSettings;
  gatewayEnabled: boolean;
}

export function useBranchSettings() {
  return useQuery({ queryKey: ['branch-settings'], queryFn: () => get<BranchInfo>('/settings/branch'), staleTime: 5 * 60_000 });
}

export const METHOD_LABEL: Record<string, string> = {
  CASH: 'เงินสด',
  PROMPTPAY: 'PromptPay',
  CARD: 'บัตร (EDC)',
  EWALLET: 'e-Wallet',
  TRANSFER: 'โอนเงิน',
  VOUCHER: 'คูปอง/Voucher',
  POINTS: 'แต้มสะสม',
  STORED_VALUE: 'บัตรเงินสด/เงินในบัญชี',
};
