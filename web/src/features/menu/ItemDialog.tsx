import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { ALLERGENS, MENU_TAGS } from '@shared/menu';
import { toSatang } from '@shared/money';
import { SALES_CHANNELS } from '@shared/states';
import { Button, Checkbox, Dialog, Input, MoneyInput, Select, Tabs, Textarea, useToast } from '../../components/ui';
import { api, ApiError, errorMessage, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { AdminItem, AdminMenu, Station } from './types';

const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
export const CHANNEL_LABEL: Record<string, string> = {
  DINE_IN: 'ทานที่ร้าน',
  TAKEAWAY: 'กลับบ้าน',
  DELIVERY: 'เดลิเวอรี่ร้าน',
  GRAB: 'GrabFood',
  LINEMAN: 'LINE MAN',
  SHOPEEFOOD: 'ShopeeFood',
  QR: 'QR สั่งเอง',
};
const baht = (s: number) => (s / 100).toFixed(2);

type Tab = 'basic' | 'options' | 'pricing' | 'availability';

export function ItemDialog({ item, menu, stations, defaultCategoryId, onClose }: { item: AdminItem | 'new'; menu: AdminMenu; stations: Station[]; defaultCategoryId?: string; onClose: () => void }) {
  const isNew = item === 'new';
  const src = isNew ? null : item;
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>('basic');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [f, setF] = useState({
    categoryId: src?.categoryId ?? defaultCategoryId ?? menu.categories.find((c) => !c.archivedAt)?.id ?? '',
    name: src?.name ?? '',
    nameEn: src?.nameEn ?? '',
    nameZh: src?.nameZh ?? '',
    description: src?.description ?? '',
    descriptionEn: src?.descriptionEn ?? '',
    descriptionZh: src?.descriptionZh ?? '',
    sku: src?.sku ?? '',
    barcode: src?.barcode ?? '',
    price: src ? baht(src.priceSatang) : '',
    stationCode: src?.stationCode ?? '',
    tags: src?.tags ?? [],
    allergens: src?.allergens ?? [],
    defaultCourse: src?.defaultCourse ?? 1,
    isCombo: src?.isCombo ?? false,
    hideOnQr: src?.hideOnQr ?? false,
    availableDays: src?.availableDays ?? 127,
    availableFrom: src?.availableFrom ?? '',
    availableTo: src?.availableTo ?? '',
    modifierGroupIds: src?.modifierGroupIds ?? [],
    prices: (src?.prices ?? []).map((p) => ({ ...p, price: baht(p.priceSatang) })),
    comboComponents: src?.comboComponents ?? [],
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const toggle = (k: 'tags' | 'allergens' | 'modifierGroupIds', v: string) => set(k, f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v]);

  const save = useMutation({
    mutationFn: async () => {
      const errs: Record<string, string> = {};
      let priceSatang = 0;
      try {
        priceSatang = toSatang(f.price);
        if (priceSatang < 0) throw new Error();
      } catch {
        errs.price = 'ราคาไม่ถูกต้อง';
      }
      const prices = f.prices.map((p) => {
        try {
          return { branchId: p.branchId, channel: p.channel, priceSatang: toSatang(p.price) };
        } catch {
          errs.prices = 'ราคาพิเศษไม่ถูกต้อง';
          return { branchId: p.branchId, channel: p.channel, priceSatang: 0 };
        }
      });
      if (!f.name.trim()) errs.name = 'ต้องระบุชื่อ';
      if (Object.keys(errs).length) {
        setErrors(errs);
        throw new Error('กรุณาแก้ไขข้อมูลที่ไม่ถูกต้อง');
      }
      const body = {
        ...f,
        priceSatang,
        prices,
        stationCode: f.stationCode || null,
        availableFrom: f.availableFrom || null,
        availableTo: f.availableTo || null,
        price: undefined,
      };
      return isNew ? post<AdminItem>('/menu/items', body) : put<AdminItem>(`/menu/items/${src!.id}`, body);
    },
    onSuccess: () => {
      toast.success(isNew ? 'เพิ่มเมนูแล้ว' : 'บันทึกเมนูแล้ว');
      qc.invalidateQueries({ queryKey: ['menu-admin'] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && Array.isArray(e.details)) setErrors(Object.fromEntries((e.details as { path: string; message: string }[]).map((d) => [d.path.split('.')[0], d.message])));
      toast.error(errorMessage(e));
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api<{ imageUrl: string }>('POST', `/menu/items/${src!.id}/image`, fd);
    },
    onSuccess: () => {
      toast.success('อัปโหลดรูปแล้ว');
      qc.invalidateQueries({ queryKey: ['menu-admin'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const activeGroups = menu.modifierGroups.filter((g) => !g.archivedAt);
  const otherItems = menu.items.filter((i) => !i.archivedAt && i.id !== src?.id && !i.isCombo);

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={isNew ? 'เพิ่มเมนู' : `แก้ไข ${src!.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            บันทึก
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'basic', label: 'ข้อมูลหลัก' },
          { value: 'options', label: `ตัวเลือก (${f.modifierGroupIds.length})` },
          { value: 'pricing', label: 'ราคาพิเศษ' },
          { value: 'availability', label: 'ช่วงเวลาขาย' },
        ]}
      />
      {tab === 'basic' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="หมวดหมู่" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)} required>
            {menu.categories
              .filter((c) => !c.archivedAt)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
          <MoneyInput label="ราคา (บาท)" value={f.price} onChange={(e) => set('price', e.target.value)} required error={errors.price ?? errors.priceSatang} />
          <Input label="ชื่อ (ไทย)" value={f.name} onChange={(e) => set('name', e.target.value)} required error={errors.name} />
          <Input label="ชื่อ (English)" value={f.nameEn} onChange={(e) => set('nameEn', e.target.value)} />
          <Input label="ชื่อ (中文)" value={f.nameZh} onChange={(e) => set('nameZh', e.target.value)} />
          <Select label="สเตชันครัว" value={f.stationCode} onChange={(e) => set('stationCode', e.target.value)} hint="เว้นว่าง = ใช้ตามหมวดหมู่">
            <option value="">ตามหมวดหมู่</option>
            {stations.map((s) => (
              <option key={s.id} value={s.code}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
          <Textarea label="คำอธิบาย (ไทย)" wrapClassName="sm:col-span-2" value={f.description} onChange={(e) => set('description', e.target.value)} />
          <Textarea label="คำอธิบาย (English)" value={f.descriptionEn} onChange={(e) => set('descriptionEn', e.target.value)} />
          <Textarea label="คำอธิบาย (中文)" value={f.descriptionZh} onChange={(e) => set('descriptionZh', e.target.value)} />
          <Input label="SKU" value={f.sku} onChange={(e) => set('sku', e.target.value)} error={errors.sku} />
          <Input label="บาร์โค้ด" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} />
          <Select label="รอบเสิร์ฟเริ่มต้น" value={f.defaultCourse} onChange={(e) => set('defaultCourse', Number(e.target.value))}>
            <option value={1}>1 — ของทานเล่น/ทั่วไป</option>
            <option value={2}>2 — จานหลัก</option>
            <option value={3}>3 — ของหวาน</option>
          </Select>
          <div className="flex flex-col justify-end gap-2">
            <Checkbox label="เมนูชุด (Combo/Set)" checked={f.isCombo} onChange={(e) => set('isCombo', e.target.checked)} />
            <Checkbox label="ซ่อนจากเมนู QR ลูกค้า" checked={f.hideOnQr} onChange={(e) => set('hideOnQr', e.target.checked)} />
          </div>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-sm font-medium text-ink-2">แท็ก</legend>
            <div className="flex flex-wrap gap-3">
              {Object.entries(MENU_TAGS).map(([k, label]) => (
                <Checkbox key={k} label={label} checked={f.tags.includes(k)} onChange={() => toggle('tags', k)} />
              ))}
            </div>
          </fieldset>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-sm font-medium text-ink-2">สารก่อภูมิแพ้</legend>
            <div className="flex flex-wrap gap-3">
              {Object.entries(ALLERGENS).map(([k, label]) => (
                <Checkbox key={k} label={label} checked={f.allergens.includes(k)} onChange={() => toggle('allergens', k)} />
              ))}
            </div>
          </fieldset>
          {f.isCombo && (
            <fieldset className="sm:col-span-2">
              <legend className="mb-1 text-sm font-medium text-ink-2">ส่วนประกอบของชุด</legend>
              <div className="flex flex-col gap-2">
                {f.comboComponents.map((c, i) => (
                  <div key={i} className="flex items-end gap-2">
                    <Select
                      wrapClassName="flex-1"
                      value={c.componentItemId}
                      onChange={(e) => set('comboComponents', f.comboComponents.map((x, j) => (j === i ? { ...x, componentItemId: e.target.value } : x)))}
                      aria-label="เมนู"
                    >
                      {otherItems.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      wrapClassName="w-24"
                      aria-label="จำนวน"
                      value={c.qty}
                      onChange={(e) => set('comboComponents', f.comboComponents.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)))}
                    />
                    <Button variant="ghost" aria-label="ลบ" icon={<Trash2 className="size-4" />} onClick={() => set('comboComponents', f.comboComponents.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  icon={<Plus className="size-4" />}
                  disabled={otherItems.length === 0}
                  onClick={() => set('comboComponents', [...f.comboComponents, { componentItemId: otherItems[0].id, qty: 1 }])}
                >
                  เพิ่มส่วนประกอบ
                </Button>
              </div>
            </fieldset>
          )}
          {!isNew && (
            <div className="flex items-center gap-3 sm:col-span-2">
              {src!.imageUrl ? <img src={src!.imageUrl} alt="" className="size-20 rounded-control object-cover" /> : <div className="flex size-20 items-center justify-center rounded-control bg-sunken text-ink-3"><ImagePlus /></div>}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
              <Button variant="outline" size="sm" loading={upload.isPending} onClick={() => fileRef.current?.click()}>
                {src!.imageUrl ? 'เปลี่ยนรูป' : 'อัปโหลดรูป'}
              </Button>
              <span className="text-xs text-ink-3">JPG/PNG/WEBP ไม่เกิน 2 MB</span>
            </div>
          )}
          {isNew && <p className="text-sm text-ink-3 sm:col-span-2">อัปโหลดรูปได้หลังบันทึกเมนู</p>}
        </div>
      )}
      {tab === 'options' && (
        <div className="flex flex-col gap-2">
          {activeGroups.length === 0 && <p className="text-ink-2">ยังไม่มีกลุ่มตัวเลือก สร้างได้ที่แท็บ "ตัวเลือก"</p>}
          {activeGroups.map((g) => (
            <Checkbox
              key={g.id}
              checked={f.modifierGroupIds.includes(g.id)}
              onChange={() => toggle('modifierGroupIds', g.id)}
              label={
                <span>
                  <b>{g.name}</b>{' '}
                  <span className="text-ink-3">
                    ({g.minSelect > 0 ? `บังคับ ${g.minSelect}` : 'ไม่บังคับ'}, สูงสุด {g.maxSelect || 'ไม่จำกัด'}) · {g.modifiers.filter((m) => !m.archivedAt).map((m) => m.name).join(', ')}
                  </span>
                </span>
              }
            />
          ))}
        </div>
      )}
      {tab === 'pricing' && (
        <div className="flex flex-col gap-2">
          <p className="mb-1 text-sm text-ink-2">ราคาที่เจาะจงที่สุดจะถูกใช้: สาขา+ช่องทาง → สาขา → ช่องทาง → ราคาปกติ</p>
          {errors.prices && <p className="text-sm text-chili">{errors.prices}</p>}
          {f.prices.map((p, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <Select
                label={i === 0 ? 'สาขา' : undefined}
                wrapClassName="min-w-40 flex-1"
                value={p.branchId ?? ''}
                onChange={(e) => set('prices', f.prices.map((x, j) => (j === i ? { ...x, branchId: e.target.value || null } : x)))}
              >
                <option value="">ทุกสาขา</option>
                {me?.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
              <Select
                label={i === 0 ? 'ช่องทาง' : undefined}
                wrapClassName="min-w-40 flex-1"
                value={p.channel ?? ''}
                onChange={(e) => set('prices', f.prices.map((x, j) => (j === i ? { ...x, channel: e.target.value || null } : x)))}
              >
                <option value="">ทุกช่องทาง</option>
                {SALES_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </Select>
              <MoneyInput label={i === 0 ? 'ราคา' : undefined} wrapClassName="w-32" value={p.price} onChange={(e) => set('prices', f.prices.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
              <Button variant="ghost" aria-label="ลบราคา" icon={<Trash2 className="size-4" />} onClick={() => set('prices', f.prices.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            icon={<Plus className="size-4" />}
            onClick={() => set('prices', [...f.prices, { branchId: null, channel: 'GRAB', priceSatang: 0, price: f.price }])}
          >
            เพิ่มราคาพิเศษ
          </Button>
        </div>
      )}
      {tab === 'availability' && (
        <div className="flex flex-col gap-4">
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-ink-2">วันที่ขาย</legend>
            <div className="flex flex-wrap gap-3">
              {DAYS.map((d, i) => (
                <Checkbox key={d} label={d} checked={(f.availableDays & (1 << i)) !== 0} onChange={() => set('availableDays', f.availableDays ^ (1 << i) || f.availableDays)} />
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <Input label="เริ่มขาย" type="time" value={f.availableFrom} onChange={(e) => set('availableFrom', e.target.value)} wrapClassName="w-40" />
            <Input label="หยุดขาย" type="time" value={f.availableTo} onChange={(e) => set('availableTo', e.target.value)} wrapClassName="w-40" hint="เว้นว่างทั้งคู่ = ขายตลอดเวลาเปิดร้าน" />
          </div>
        </div>
      )}
    </Dialog>
  );
}
