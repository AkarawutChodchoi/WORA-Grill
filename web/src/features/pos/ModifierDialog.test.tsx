// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../menu/types';
import { ModifierDialog } from './ModifierDialog';

// jsdom lacks <dialog>.showModal
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};

const item: MenuItem = {
  id: 'i1',
  categoryId: 'c1',
  sku: null,
  barcode: null,
  name: 'กะเพรา',
  nameEn: null,
  nameZh: null,
  description: null,
  imageUrl: null,
  priceSatang: 7000,
  stationCode: 'HOT',
  tags: [],
  allergens: ['soy'],
  defaultCourse: 2,
  isCombo: false,
  soldOut: false,
  available: true,
  unavailableReason: null,
  comboComponents: [],
  modifierGroups: [
    { id: 'g1', name: 'ความเผ็ด', minSelect: 1, maxSelect: 1, allowRepeat: false, modifiers: [{ id: 'm1', name: 'เผ็ดมาก', priceDeltaSatang: 0 }] },
    { id: 'g2', name: 'เพิ่ม', minSelect: 0, maxSelect: 2, allowRepeat: true, modifiers: [{ id: 'e1', name: 'ไข่ดาว', priceDeltaSatang: 1000 }] },
  ],
};

describe('ModifierDialog', () => {
  it('blocks adding until required groups are chosen, then returns priced line', () => {
    const onConfirm = vi.fn();
    render(<ModifierDialog item={item} onClose={() => undefined} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: /เพิ่ม · / }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('ความเผ็ด');
    fireEvent.click(screen.getByRole('button', { name: 'เผ็ดมาก' }));
    fireEvent.click(screen.getByRole('button', { name: /ไข่ดาว/ }));
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มจำนวน' }));
    fireEvent.click(screen.getByRole('button', { name: /เพิ่ม · / }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ qty: 2, unitPriceSatang: 8000, course: 2 }));
  });
});
