import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Clock3, UserCheck, UsersRound } from 'lucide-react';
import {
  getListAttendanceQueryKey, getListEmployeesQueryKey, useListAttendance, useListEmployees,
} from '@workspace/api-client-react';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { makeRowKey, SpreadsheetGrid, type ColDef } from '@/components/SpreadsheetGrid';
import { bulkSaveAttendance, bulkSaveEmployees } from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { resolveRows, useGridSync } from '@/lib/use-grid-sync';
import { emptyRows, shortDate, todayISO } from '@/lib/utils';

type EmployeeRow = {
  _key: string; _selected?: boolean; id?: number;
  fullName: string; role: string; phone: string; startDate: string; status: string; notes: string;
};

type AttendanceRow = {
  _key: string; _selected?: boolean; id?: number;
  employeeId: string; attendanceDate: string; checkIn: string; checkOut: string; status: string; notes: string;
};

function blankEmployee(): EmployeeRow {
  return { _key: makeRowKey(), fullName: '', role: '', phone: '', startDate: todayISO(), status: 'active', notes: '' };
}

function blankAttendance(date: string, empId: string): AttendanceRow {
  return { _key: makeRowKey(), employeeId: empId, attendanceDate: date, checkIn: '08:00', checkOut: '', status: 'present', notes: '' };
}

export function StaffPage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const date = todayISO();
  const employeesQuery = useListEmployees();
  const attendanceQuery = useListAttendance({ date });
  const employees = employeesQuery.data ?? [];
  const attendance = attendanceQuery.data ?? [];
  const [delEmp, setDelEmp] = useState<number[]>([]);
  const [delAtt, setDelAtt] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');

  const buildEmpRows = useCallback(() => [
    ...employees.map((e) => ({
      _key: `e-${e.id}`, id: e.id, fullName: e.fullName, role: e.role, phone: e.phone ?? '',
      startDate: e.startDate, status: e.status, notes: e.notes ?? '',
    })),
    ...emptyRows(Math.max(0, 6 - employees.length), blankEmployee),
  ], [employees]);

  const buildAttRows = useCallback(() => [
    ...attendance.map((a) => ({
      _key: `a-${a.id}`, id: a.id, employeeId: String(a.employeeId), attendanceDate: a.attendanceDate,
      checkIn: a.checkIn, checkOut: a.checkOut ?? '', status: a.status, notes: a.notes ?? '',
    })),
    ...emptyRows(Math.max(0, 10 - attendance.length), () => blankAttendance(date, String(employees[0]?.id ?? '0'))),
  ], [attendance, date, employees]);

  const { rows: empRows, setRows: setEmpRows, markDirty: markEmpDirty, markClean: markEmpClean } = useGridSync(
    employeesQuery.dataUpdatedAt, employeesQuery.isFetched, buildEmpRows,
  );
  const { rows: attRows, setRows: setAttRows, markDirty: markAttDirty, markClean: markAttClean } = useGridSync(
    `${date}-${attendanceQuery.dataUpdatedAt}`, attendanceQuery.isFetched, buildAttRows,
  );

  const statusOpts = useMemo(() => [
    { value: 'active', label: t('active') }, { value: 'inactive', label: t('inactive') },
  ], [t]);
  const attStatusOpts = useMemo(() => [
    { value: 'present', label: t('present') }, { value: 'late', label: t('late') },
    { value: 'absent', label: t('absent') }, { value: 'leave', label: t('leave') },
  ], [t]);
  const empOpts = useMemo(() => [
    { value: '0', label: '—' },
    ...employees.map((e) => ({ value: String(e.id), label: e.fullName })),
  ], [employees]);

  const empCols: ColDef<EmployeeRow>[] = useMemo(() => [
    { key: 'fullName', label: t('name'), width: '160px' },
    { key: 'role', label: t('role'), width: '120px' },
    { key: 'phone', label: t('phone'), width: '120px' },
    { key: 'startDate', label: t('startDate'), type: 'date', width: '120px' },
    { key: 'status', label: t('status'), type: 'select', options: statusOpts, width: '100px' },
    { key: 'notes', label: t('note'), width: '140px' },
  ], [statusOpts, t]);

  const attCols: ColDef<AttendanceRow>[] = useMemo(() => [
    { key: 'employeeId', label: t('name'), type: 'select', options: empOpts, width: '160px' },
    { key: 'attendanceDate', label: t('date'), type: 'date', width: '120px' },
    { key: 'checkIn', label: t('checkIn'), type: 'time', width: '90px' },
    { key: 'checkOut', label: t('checkOut'), type: 'time', width: '90px' },
    { key: 'status', label: t('status'), type: 'select', options: attStatusOpts, width: '100px' },
    { key: 'notes', label: t('note'), width: '140px' },
  ], [attStatusOpts, empOpts, t]);

  const activeCount = employees.filter((e) => e.status === 'active').length;

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      const empPayload = empRows.filter((r) => r.fullName.trim()).map(({ _key, _selected, ...rest }) => ({
        ...rest, status: rest.status as 'active' | 'inactive',
      }));
      const attPayload = attRows.filter((r) => r.employeeId !== '0' && r.checkIn).map(({ _key, _selected, ...rest }) => ({
        ...rest, employeeId: Number(rest.employeeId), status: rest.status as 'present' | 'late' | 'absent' | 'leave',
      }));
      await Promise.all([bulkSaveEmployees(empPayload, delEmp), bulkSaveAttendance(attPayload, delAtt)]);
      setDelEmp([]); setDelAtt([]);
      markEmpClean(); markAttClean();
      await qc.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
      await qc.invalidateQueries({ queryKey: getListAttendanceQueryKey({ date }) });
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch {
      setFlash(t('saveFailed'));
      window.setTimeout(() => setFlash(''), 2500);
    } finally {
      setSaving(false);
    }
  };

  const onEmpChange = (next: Parameters<typeof setEmpRows>[0]) => {
    markEmpDirty();
    setEmpRows((prev) => {
      const resolved = resolveRows(prev, next);
      const removed = prev.filter((r) => r.id && !resolved.find((n) => n._key === r._key));
      setDelEmp((p) => [...p, ...removed.map((r) => r.id!).filter((id) => !p.includes(id))]);
      return resolved;
    });
  };

  const onAttChange = (next: Parameters<typeof setAttRows>[0]) => {
    markAttDirty();
    setAttRows((prev) => {
      const resolved = resolveRows(prev, next);
      const removed = prev.filter((r) => r.id && !resolved.find((n) => n._key === r._key));
      setDelAtt((p) => [...p, ...removed.map((r) => r.id!).filter((id) => !p.includes(id))]);
      return resolved;
    });
  };

  return (
    <div className="fade-up">
      <PageTitle eyebrow="GIA / TIM" title={t('staff')} description={t('staffDesc')}
        action={<div className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] px-3 py-2 text-xs font-semibold"><CalendarDays size={15} />{shortDate(date)}</div>} />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label={lang === 'id' ? 'Staf aktif' : 'الموظفون النشطون'} value={String(activeCount).padStart(2, '0')} detail={lang === 'id' ? 'Direktori' : 'الدليل'} icon={UsersRound} />
        <Metric label={t('attendance')} value={`${attendance.length}/${employees.length}`} detail={t('today')} icon={UserCheck} tone="primary" />
        <Metric label={lang === 'id' ? 'Belum check-out' : 'لم يسجل الخروج'} value={String(attendance.filter((a) => !a.checkOut).length)} detail={lang === 'id' ? 'Masih shift' : 'في الوردية'} icon={Clock3} />
      </div>
      <div className="space-y-6">
        <section>
          <h2 className="mb-3 text-sm font-bold">{lang === 'id' ? 'Direktori staf' : 'دليل الموظفين'}</h2>
          <SpreadsheetGrid columns={empCols} rows={empRows} onRowsChange={onEmpChange} onSave={handleSaveAll} saving={saving} lang={lang} t={t} exportFilename="gia-employees" minHeight="280px" />
        </section>
        <section>
          <h2 className="mb-3 text-sm font-bold">{lang === 'id' ? 'Absensi hari ini' : 'حضور اليوم'}</h2>
          <SpreadsheetGrid columns={attCols} rows={attRows} onRowsChange={onAttChange} onSave={handleSaveAll} saving={saving} lang={lang} t={t} exportFilename={`gia-attendance-${date}`} minHeight="360px" />
        </section>
      </div>
      <Flash message={flash} />
    </div>
  );
}
