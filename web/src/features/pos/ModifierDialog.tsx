import { clsx } from 'clsx';
import { Minus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ALLERGENS } from '@shared/menu';
import { unitPriceWithModifiers, validateModifiers } from '@shared/menu';
import { Badge, Button, Dialog, Input, Select } from '../../components/ui';
import { formatBaht } from '../../lib/format';
import type { MenuItem } from '../menu/types';
import type { DraftLine } from './types';

/** Choose modifiers, quantity, note and course for one menu item. Rules are checked client-side for UX and again on the server. */
export function ModifierDialog({
  item,
  initial,
  onClose,
  onConfirm,
  onRemove,
}: {
  item: MenuItem;
  initial?: DraftLine;
  onClose: () => void;
  onConfirm: (line: Omit<DraftLine, 'id'>) => void;
  onRemove?: () => void;
}) {
  const [qty, setQty] = useState(initial?.qty ?? 1);
  const [note, setNote] = useState(initial?.note ?? '');
  const [course, setCourse] = useState(initial?.course ?? item.defaultCourse);
  const [held, setHeld] = useState(initial?.held ?? false);
  const [picked, setPicked] = useState<Record<string, number>>(() => {
    if (initial) return Object.fromEntries(initial.modifiers.map((m) => [m.modifierId, m.qty ?? 1]));
    const d: Record<string, number> = {};
    for (const g of item.modifierGroups) for (const m of g.modifiers) if (m.isDefault) d[m.id] = 1;
    return d;
  });
  const [touched, setTouched] = useState(false);
  const selected = Object.entries(picked)
    .filter(([, n]) => n > 0)
    .map(([modifierId, n]) => ({ modifierId, qty: n }));
  const v = useMemo(() => validateModifiers(item.modifierGroups, selected), [item, selected]);
  const unit = v.ok ? unitPriceWithModifiers(item.priceSatang, v.modifiers) : item.priceSatang;

  const toggle = (groupId: string, modId: string) => {
    const g = item.modifierGroups.find((x) => x.id === groupId)!;
    setPicked((p) => {
      const next = { ...p };
      if (g.maxSelect === 1) {
        for (const m of g.modifiers) delete next[m.id];
        if (!p[modId]) next[modId] = 1;
      } else if (next[modId]) delete next[modId];
      else next[modId] = 1;
      return next;
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={item.name}
      size="lg"
      footer={
        <>
          {onRemove && (
            <Button variant="danger-ghost" className="mr-auto" onClick={onRemove}>
              ลบรายการ
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button
            size="lg"
            onClick={() => {
              setTouched(true);
              if (!v.ok) return;
              onConfirm({
                menuItemId: item.id,
                name: item.name,
                unitPriceSatang: unit,
                qty,
                modifiers: v.modifiers.map((m) => ({ modifierId: m.modifierId, qty: m.qty, name: m.name, priceDeltaSatang: m.priceDeltaSatang })),
                note: note.trim() || undefined,
                course,
                held,
              });
            }}
          >
            {initial ? 'บันทึก' : 'เพิ่ม'} · <span className="num">{formatBaht(unit * qty)}</span>
          </Button>
        </>
      }
    >
      {item.allergens.length > 0 && (
        <p className="mb-3 flex flex-wrap items-center gap-1 text-sm">
          <span className="text-ink-2">สารก่อภูมิแพ้:</span>
          {item.allergens.map((a) => (
            <Badge key={a} tone="warning">
              {ALLERGENS[a] ?? a}
            </Badge>
          ))}
        </p>
      )}
      {item.comboComponents.length > 0 && <p className="mb-3 text-sm text-ink-2">ชุดนี้มี: {item.comboComponents.map((c) => `${c.name}${c.qty > 1 ? ` ×${c.qty}` : ''}`).join(', ')}</p>}
      <div className="flex flex-col gap-4">
        {item.modifierGroups.map((g) => {
          const count = g.modifiers.reduce((a, m) => a + (picked[m.id] ?? 0), 0);
          const missing = touched && count < g.minSelect;
          return (
            <fieldset key={g.id}>
              <legend className={clsx('mb-1.5 font-medium', missing && 'text-chili')}>
                {g.name}{' '}
                <span className="text-sm font-normal text-ink-3">
                  {g.minSelect > 0 ? `(เลือก ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}–${g.maxSelect || 'ไม่จำกัด'}`})` : `(ไม่บังคับ${g.maxSelect ? `, สูงสุด ${g.maxSelect}` : ''})`}
                </span>
              </legend>
              <div className="flex flex-wrap gap-2">
                {g.modifiers.map((m) => {
                  const on = (picked[m.id] ?? 0) > 0;
                  return (
                    <div key={m.id} className="flex items-center">
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle(g.id, m.id)}
                        className={clsx('min-h-11 rounded-control border px-3 py-2 text-left', on ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface hover:bg-sunken')}
                      >
                        {m.name}
                        {m.priceDeltaSatang !== 0 && <span className="num ml-1 text-sm opacity-80">{m.priceDeltaSatang > 0 ? '+' : ''}{formatBaht(m.priceDeltaSatang)}</span>}
                        {picked[m.id] > 1 && <span className="ml-1 font-semibold">×{picked[m.id]}</span>}
                      </button>
                      {on && g.allowRepeat && (
                        <button type="button" aria-label={`เพิ่ม ${m.name}`} className="ml-1 rounded-control border border-line-strong p-2" onClick={() => setPicked((p) => ({ ...p, [m.id]: (p[m.id] ?? 0) + 1 }))}>
                          <Plus className="size-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
        {!v.ok && touched && (
          <p className="text-sm text-chili" role="alert">
            {v.errors.join(' · ')}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="mb-1 text-sm font-medium text-ink-2">จำนวน</div>
            <div className="flex items-center gap-2">
              <Button variant="outline" aria-label="ลดจำนวน" icon={<Minus className="size-4" />} onClick={() => setQty(Math.max(1, qty - 1))} />
              <span className="num w-10 text-center text-xl font-semibold">{qty}</span>
              <Button variant="outline" aria-label="เพิ่มจำนวน" icon={<Plus className="size-4" />} onClick={() => setQty(Math.min(99, qty + 1))} />
            </div>
          </div>
          <Select label="รอบเสิร์ฟ" value={course} onChange={(e) => setCourse(Number(e.target.value))} wrapClassName="w-40">
            <option value={1}>1 ของทานเล่น</option>
            <option value={2}>2 จานหลัก</option>
            <option value={3}>3 ของหวาน</option>
          </Select>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand" checked={held} onChange={(e) => setHeld(e.target.checked)} />
            พักไว้ก่อน (Hold)
          </label>
        </div>
        <Input label="หมายเหตุถึงครัว" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ไม่ใส่ผัก, แพ้ถั่ว" maxLength={200} />
        <div className="flex flex-wrap gap-1.5">
          {['ไม่ใส่ผัก', 'ไม่ใส่ผงชูรส', 'แพ้ถั่ว', 'ไม่เผ็ด', 'แยกน้ำ', 'ใส่กล่อง'].map((q) => (
            <button key={q} type="button" className="min-h-10 rounded-full border border-line-strong px-3 text-sm hover:bg-sunken" onClick={() => setNote(note ? `${note}, ${q}` : q)}>
              {q}
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
